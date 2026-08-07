import { dispatchCommand } from "../application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../domain/commands.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import { buildDevelopmentPrompt, buildCommentContext } from "./prompts.mjs";
import { stateChangeText } from "../clickup/state-comments.mjs";

function extractJson(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return stdout;
  return stdout.slice(start, end + 1);
}

function concise(text, max = 60) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

async function rollbackDevelopment({ db, client, taskId, jobId, now }) {
  try {
    const current = await loadAggregate(db, "task", taskId);
    if (current.state !== "developing") return;
    await dispatchCommand({
      db,
      command: parseCommandEnvelope({
        id: `development-failed-${jobId}`,
        type: "development_failed",
        aggregateType: "task",
        aggregateId: taskId,
        expectedVersion: current.version + 1,
        actorId: "runner-developer",
        issuedAt: now,
        reason: "development failed",
        parameters: { evidenceId: `development-${jobId}` },
      }),
      now,
    });
    const comment = stateChangeText("task", "developing", "ready_for_development");
    if (comment) {
      try {
        await client.postComment(taskId, comment);
      } catch {
        // 评论失败不影响回退
      }
    }
  } catch {
    // 回退失败不掩盖原始错误
  }
}

async function markDevelopmentNeedsInfo({ db, client, taskId, jobId, now, reason }) {
  const aggregate = await loadAggregate(db, "task", taskId);
  if (aggregate.state !== "developing") return;
  const command = parseCommandEnvelope({
    id: `development-needs-info-${jobId}`,
    type: "development_needs_info",
    aggregateType: "task",
    aggregateId: taskId,
    expectedVersion: aggregate.version + 1,
    actorId: "runner-developer",
    issuedAt: now,
    reason,
    parameters: {},
  });
  try {
    await dispatchCommand({ db, command, now });
  } catch {
    // 状态推进失败不掩盖 needs_info 结论；用户恢复开发后仍可继续
  }
  try {
    await client.postComment(
      taskId,
      [
        `⚠️ 开发无法完成：${concise(reason, 200)}`,
        "请补充必要信息（如具体静音文件名/复现方式/预期结果），然后把任务状态改回「开发中」继续。",
      ].join("\n"),
    );
  } catch {
    // 评论失败不影响状态
  }
}

export async function executeDevelopment({
  job,
  db,
  client,
  codex,
  gitOps,
  now,
  fieldIds = { evidence: "field-evidence" },
}) {
  const { taskId, repoPath, worktreesRoot, baseRef, versionBranch, acceptanceCriteria } = job.payload;
  try {
    const task = await client.getTask(taskId);
    let commentContext = null;
    try {
      commentContext = buildCommentContext(await client.getComments(taskId));
    } catch {}
    const feedbackField = task.custom_fields?.find(
      (field) => field.name === "验收反馈" || field.id === "field-acceptance-feedback",
    );
    if (feedbackField?.value) {
      commentContext = [commentContext, `验收反馈：${feedbackField.value}`]
        .filter(Boolean)
        .join("\n");
    }
    const worktree = await gitOps.createWorktree({
      repoPath,
      taskId,
      baseRef,
      worktreesRoot,
    });
    const startAggregate = await loadAggregate(db, "task", taskId);
    if (startAggregate.state !== "developing") {
      await dispatchCommand({
        db,
        command: parseCommandEnvelope({
          id: `development-start-${job.id}`,
          type: "start_development",
          aggregateType: "task",
          aggregateId: taskId,
          expectedVersion: startAggregate.version + 1,
          actorId: "runner-developer",
          issuedAt: now,
          reason: "development started",
          parameters: {},
        }),
        now,
      });
      const comment = stateChangeText("task", "ready_for_development", "developing");
      if (comment) {
        try {
          await client.postComment(taskId, comment);
        } catch {
          // 评论失败不影响开发
        }
      }
    }
    const run = await codex.run({
      prompt: buildDevelopmentPrompt(task, acceptanceCriteria, commentContext),
      workdir: worktree.worktreePath,
      taskId,
    });
    if (run.exitCode !== 0) {
      await rollbackDevelopment({ db, client, taskId, jobId: job.id, now });
      return { status: "failed", error: `codex exited ${run.exitCode}: ${run.stderr}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(extractJson(run.stdout));
    } catch {
      await rollbackDevelopment({ db, client, taskId, jobId: job.id, now });
      return { status: "failed", error: "invalid JSON output" };
    }
    if (parsed.needs_info === true) {
      const reason = typeof parsed.reason === "string" && parsed.reason.trim() !== ""
        ? parsed.reason.trim()
        : "开发过程中无法复现问题或信息不足";
      await markDevelopmentNeedsInfo({ db, client, taskId, jobId: job.id, now, reason });
      return { status: "failed", error: `needs_info: ${reason}` };
    }
    if (typeof parsed.change_summary !== "string" || parsed.change_summary === "") {
      await rollbackDevelopment({ db, client, taskId, jobId: job.id, now });
      return { status: "failed", error: "missing change_summary" };
    }
    await gitOps.commitAll(worktree.worktreePath, `Task ${taskId}: ${parsed.change_summary}`);
    const pr = await gitOps.createPullRequest({
      repoPath,
      branch: worktree.branch,
      base: versionBranch ?? baseRef,
      baseRef,
      title: `Task ${taskId}: ${task.name}`,
      body: [
        `改动摘要：${parsed.change_summary}`,
        ...(acceptanceCriteria ?? []).map((criterion) => `- 验收 ${criterion.id}: ${criterion.criterion}`),
      ].join("\n"),
    });

    await client.updateCustomField(taskId, fieldIds.evidence, pr.url ?? String(pr));

    const aggregate = await loadAggregate(db, "task", taskId);
    const command = parseCommandEnvelope({
      id: `development-${job.id}`,
      type: "development_completed",
      aggregateType: "task",
      aggregateId: taskId,
      expectedVersion: aggregate.version + 1,
      actorId: "runner-developer",
      issuedAt: now,
      reason: "development completed",
      parameters: {},
    });
    const result = await dispatchCommand({ db, command, now });
    return {
      status: "completed",
      commandId: result.commandId,
      pr,
      changeSummary: parsed.change_summary,
    };
  } catch (error) {
    await rollbackDevelopment({ db, taskId, jobId: job.id, now });
    return { status: "failed", error: error.message };
  }
}

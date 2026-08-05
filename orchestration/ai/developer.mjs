import { dispatchCommand } from "../application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../domain/commands.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import { buildDevelopmentPrompt } from "./prompts.mjs";

function extractJson(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return stdout;
  return stdout.slice(start, end + 1);
}

function concise(text, max = 60) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

async function rollbackDevelopment({ db, taskId, jobId, now }) {
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
  } catch {
    // 回退失败不掩盖原始错误
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
    }
    const run = await codex.run({
      prompt: buildDevelopmentPrompt(task, acceptanceCriteria),
      workdir: worktree.worktreePath,
      taskId,
    });
    if (run.exitCode !== 0) {
      await rollbackDevelopment({ db, taskId, jobId: job.id, now });
      return { status: "failed", error: `codex exited ${run.exitCode}: ${run.stderr}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(extractJson(run.stdout));
    } catch {
      await rollbackDevelopment({ db, taskId, jobId: job.id, now });
      return { status: "failed", error: "invalid JSON output" };
    }
    if (typeof parsed.change_summary !== "string" || parsed.change_summary === "") {
      await rollbackDevelopment({ db, taskId, jobId: job.id, now });
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

    await client.postComment(
      taskId,
      `✅ 开发完成，PR：${pr.url ?? pr}`,
    );
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

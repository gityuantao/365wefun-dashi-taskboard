import { dispatchCommand } from "../application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../domain/commands.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import { collectCommentMedia } from "../clickup/comment-media.mjs";
import { redactCredentials } from "../domain/redaction.mjs";
import { resolveTaskPlatforms } from "../domain/platforms.mjs";
import {
  buildDevelopmentPrompt,
  commentImageDecodeFailure,
  formatCommentMediaError,
  formatCommentMediaDiagnostics,
  formatCodexMediaRunFailure,
} from "./prompts.mjs";

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

function safeDiagnostic(reason) {
  return concise(redactCredentials(reason), 200);
}

async function rollbackDevelopment({ db, client, taskId, jobId, now, reason }) {
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
        issuedAt: new Date().toISOString(),
        reason: "development failed",
        parameters: { evidenceId: `development-${jobId}` },
      }),
      now: new Date().toISOString(),
    });
    const comment = stateChangeText(
      "task",
      "developing",
      "ready_for_development",
      safeDiagnostic(reason),
    );
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
  if (aggregate.state !== "developing") return false;
  const command = parseCommandEnvelope({
    id: `development-needs-info-${jobId}`,
    type: "development_needs_info",
    aggregateType: "task",
    aggregateId: taskId,
    expectedVersion: aggregate.version + 1,
    actorId: "runner-developer",
    issuedAt: new Date().toISOString(),
    reason,
    parameters: {},
  });
  try {
    await dispatchCommand({ db, command, now: new Date().toISOString() });
  } catch {
    return false;
  }
  try {
    await client.postComment(
      taskId,
      [
        `⚠️ 开发无法完成：${safeDiagnostic(reason)}`,
        "请补充必要信息（如具体静音文件名/复现方式/预期结果），然后把任务状态改回「开发中」继续。",
      ].join("\n"),
    );
  } catch {
    // 评论失败不影响状态
  }
  return true;
}

function staleDevelopmentResult(aggregate) {
  const result = {
    status: "failed",
    error: `stale develop job: task is in ${aggregate.state} at version ${aggregate.version}`,
  };
  if (aggregate.state === "waiting_info") result.classification = "paused_waiting_info";
  return result;
}

async function currentDevelopment(db, taskId, expectedVersion) {
  const aggregate = await loadAggregate(db, "task", taskId);
  return {
    active: aggregate.state === "developing" && aggregate.version === expectedVersion,
    aggregate,
  };
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
  const {
    taskId,
    repoPath,
    worktreesRoot,
    baseRef,
    versionBranch,
    acceptanceCriteria,
    rejectionFindings,
  } = job.payload;
  try {
    let startAggregate = await loadAggregate(db, "task", taskId);
    if (startAggregate.state !== "developing" && startAggregate.state !== "ready_for_development") {
      return staleDevelopmentResult(startAggregate);
    }
    const queuedAtVersion = Number.isInteger(job.payload.aggregateVersion)
      ? job.payload.aggregateVersion
      : null;
    if (queuedAtVersion !== null) {
      const sameVersion = startAggregate.version === queuedAtVersion;
      const startedSinceQueue = startAggregate.state === "developing"
        && startAggregate.version === queuedAtVersion + 1;
      if (!sameVersion && !startedSinceQueue) return staleDevelopmentResult(startAggregate);
    }
    if (startAggregate.state === "ready_for_development") {
      await dispatchCommand({
        db,
        command: parseCommandEnvelope({
          id: `development-start-${job.id}`,
          type: "start_development",
          aggregateType: "task",
          aggregateId: taskId,
          expectedVersion: startAggregate.version + 1,
          actorId: "runner-developer",
          issuedAt: new Date().toISOString(),
          reason: "development started",
          parameters: {},
        }),
        now: new Date().toISOString(),
      });
      const comment = stateChangeText("task", "ready_for_development", "developing");
      if (comment) {
        try {
          await client.postComment(taskId, comment);
        } catch {
          // 评论失败不影响开发
        }
      }
      startAggregate = await loadAggregate(db, "task", taskId);
    }
    const executionVersion = startAggregate.version;
    const task = await client.getTask(taskId);
    const platforms = resolveTaskPlatforms(task);
    let mediaBundle;
    try {
      const comments = await client.getComments(taskId);
      mediaBundle = await collectCommentMedia({ comments, client, taskId });
    } catch (error) {
      const reason = formatCommentMediaError(error);
      const transitioned = await markDevelopmentNeedsInfo({
        db,
        client,
        taskId,
        jobId: job.id,
        now,
        reason,
      });
      if (!transitioned) {
        return staleDevelopmentResult(await loadAggregate(db, "task", taskId));
      }
      return { status: "failed", classification: "needs_info", error: `needs_info: ${reason}` };
    }
    let activity;
    let worktree;
    let run;
    let runError;
    let codexStarted = false;
    try {
      const feedbackField = task.custom_fields?.find(
        (field) => field.name === "验收反馈" || field.id === "field-acceptance-feedback",
      );
      const acceptanceFeedback = feedbackField?.value || null;
      activity = await currentDevelopment(db, taskId, executionVersion);
      if (!activity.active) return staleDevelopmentResult(activity.aggregate);
      const diagnosticComment = formatCommentMediaDiagnostics(mediaBundle.diagnostics);
      if (diagnosticComment) {
        try {
          await client.postComment(taskId, diagnosticComment);
        } catch {
          // 截断诊断评论失败不影响已保留图片的开发
        }
      }
      worktree = await gitOps.createWorktree({
        repoPath,
        taskId,
        baseRef,
        worktreesRoot,
      });
      activity = await currentDevelopment(db, taskId, executionVersion);
      if (!activity.active) return staleDevelopmentResult(activity.aggregate);
      codexStarted = true;
      run = await codex.run({
        prompt: buildDevelopmentPrompt(
          task,
          acceptanceCriteria,
          mediaBundle.textContext,
          platforms.length > 0 ? platforms.join("、") : null,
          rejectionFindings,
          acceptanceFeedback,
        ),
        workdir: worktree.worktreePath,
        taskId,
        imagePaths: mediaBundle.images.map((image) => image.localPath),
      });
    } catch (error) {
      runError = error;
    } finally {
      await mediaBundle.cleanup();
    }
    const decodeReason = codexStarted
      ? commentImageDecodeFailure(runError ?? run, mediaBundle.images)
      : null;
    if (decodeReason) {
      const transitioned = await markDevelopmentNeedsInfo({
        db,
        client,
        taskId,
        jobId: job.id,
        now,
        reason: decodeReason,
      });
      if (!transitioned) {
        return staleDevelopmentResult(await loadAggregate(db, "task", taskId));
      }
      return {
        status: "failed",
        classification: "needs_info",
        error: `needs_info: ${decodeReason}`,
      };
    }
    if (runError) {
      const safeFailure = codexStarted
        ? formatCodexMediaRunFailure(runError, mediaBundle.images)
        : null;
      if (safeFailure) throw new Error(safeFailure);
      throw runError;
    }
    activity = await currentDevelopment(db, taskId, executionVersion);
    if (!activity.active) return staleDevelopmentResult(activity.aggregate);
    if (run.exitCode !== 0) {
      const reason = formatCodexMediaRunFailure(run, mediaBundle.images)
        ?? `codex exited ${run.exitCode}: ${run.stderr}`;
      await rollbackDevelopment({ db, client, taskId, jobId: job.id, now, reason });
      return { status: "failed", error: reason };
    }
    let parsed;
    try {
      parsed = JSON.parse(extractJson(run.stdout));
    } catch {
      await rollbackDevelopment({
        db,
        client,
        taskId,
        jobId: job.id,
        now,
        reason: "invalid JSON output",
      });
      return { status: "failed", error: "invalid JSON output" };
    }
    if (parsed.needs_info === true) {
      const reason = typeof parsed.reason === "string" && parsed.reason.trim() !== ""
        ? parsed.reason.trim()
        : "开发过程中无法复现问题或信息不足";
      const transitioned = await markDevelopmentNeedsInfo({
        db,
        client,
        taskId,
        jobId: job.id,
        now,
        reason,
      });
      if (!transitioned) {
        return staleDevelopmentResult(await loadAggregate(db, "task", taskId));
      }
      return { status: "failed", classification: "needs_info", error: `needs_info: ${reason}` };
    }
    if (typeof parsed.change_summary !== "string" || parsed.change_summary === "") {
      await rollbackDevelopment({
        db,
        client,
        taskId,
        jobId: job.id,
        now,
        reason: "missing change_summary",
      });
      return { status: "failed", error: "missing change_summary" };
    }
    activity = await currentDevelopment(db, taskId, executionVersion);
    if (!activity.active) return staleDevelopmentResult(activity.aggregate);
    const commitSha = await gitOps.commitAll(
      worktree.worktreePath,
      `Task ${taskId}: ${parsed.change_summary}`,
    );
    activity = await currentDevelopment(db, taskId, executionVersion);
    if (!activity.active) return staleDevelopmentResult(activity.aggregate);
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

    activity = await currentDevelopment(db, taskId, executionVersion);
    if (!activity.active) return staleDevelopmentResult(activity.aggregate);
    await client.updateCustomField(taskId, fieldIds.evidence, pr.url ?? String(pr));

    activity = await currentDevelopment(db, taskId, executionVersion);
    if (!activity.active) return staleDevelopmentResult(activity.aggregate);
    const aggregate = activity.aggregate;
    const command = parseCommandEnvelope({
      id: `development-${job.id}`,
      type: "development_completed",
      aggregateType: "task",
      aggregateId: taskId,
      expectedVersion: aggregate.version + 1,
      actorId: "runner-developer",
      issuedAt: new Date().toISOString(),
      reason: "development completed",
      parameters: {},
    });
    const result = await dispatchCommand({ db, command, now: new Date().toISOString() });
    return {
      status: "completed",
      commandId: result.commandId,
      pr,
      commitSha,
      platforms,
      changeSummary: parsed.change_summary,
      findingResponses: Array.isArray(parsed.finding_responses) ? parsed.finding_responses : [],
    };
  } catch (error) {
    await rollbackDevelopment({ db, client, taskId, jobId: job.id, now, reason: error.message });
    return { status: "failed", error: error.message };
  }
}

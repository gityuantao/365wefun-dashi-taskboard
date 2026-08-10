import { dispatchCommand } from "../application/dispatch-command.mjs";
import {
  recordFailure,
  resetRework,
} from "../application/failure-handler.mjs";
import { parseCommandEnvelope } from "../domain/commands.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import { collectCommentMedia } from "../clickup/comment-media.mjs";
import {
  buildAcceptancePrompt,
  commentImageDecodeFailure,
  formatCommentMediaError,
  formatCommentMediaDiagnostics,
  formatCodexMediaRunFailure,
} from "./prompts.mjs";

function extractJson(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return stdout;
  return stdout.slice(start, end + 1);
}

function conciseLine(text, max = 120) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function formatAcceptanceFeedback(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return "❌ 验收不通过：未提供具体原因。";
  }
  const lines = findings.map((finding, index) => {
    const severity = finding?.severity ? `[${finding.severity}] ` : "";
    return `${index + 1}. ${severity}${conciseLine(finding?.description)}`;
  });
  return `❌ 验收不通过：\n${lines.join("\n")}`;
}

function formatFullAcceptanceFeedback(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return "❌ 验收不通过：未提供具体原因。";
  }
  const lines = findings.map((finding, index) => {
    const severity = finding?.severity ? `[${finding.severity}] ` : "";
    return `${index + 1}. ${severity}${finding?.description ?? ""}`;
  });
  return `❌ 验收不通过：\n${lines.join("\n")}`;
}

function concise(text, max = 60) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

function staleAcceptanceResult(aggregate) {
  const result = {
    status: "failed",
    error: `stale accept job: task is in ${aggregate.state} at version ${aggregate.version}`,
  };
  if (aggregate.state === "waiting_info") result.classification = "paused_waiting_info";
  return result;
}

async function currentAcceptance(db, taskId, expectedVersion) {
  const aggregate = await loadAggregate(db, "task", taskId);
  return {
    active: aggregate.state === "accepting" && aggregate.version === expectedVersion,
    aggregate,
  };
}

function isRemoteWaitingInfo(task) {
  const status = task?.status?.status ?? task?.status;
  return status === "待补充信息" || status === "waiting_info";
}

async function pauseForRemoteWaitingInfo({ db, client, taskId, jobId }) {
  if (!isRemoteWaitingInfo(await client.getTask(taskId))) return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const aggregate = await loadAggregate(db, "task", taskId);
    if (aggregate.state === "waiting_info") return staleAcceptanceResult(aggregate);
    if (!new Set(["accepting", "ready_for_test"]).has(aggregate.state)) {
      return staleAcceptanceResult(aggregate);
    }
    try {
      await dispatchCommand({
        db,
        command: parseCommandEnvelope({
          id: `acceptance-remote-pause-${jobId}-${aggregate.version + 1}`,
          type: "manual_pause_for_info",
          aggregateType: "task",
          aggregateId: taskId,
          expectedVersion: aggregate.version + 1,
          actorId: "runner-acceptor",
          issuedAt: new Date().toISOString(),
          reason: "remote task moved to waiting_info before acceptance result",
          parameters: {},
        }),
        now: new Date().toISOString(),
      });
      return staleAcceptanceResult(await loadAggregate(db, "task", taskId));
    } catch {
      // A concurrent acceptance/poller transition may win the version race.
      // Reload once and apply the ready_for_test fallback if it is still safe.
    }
  }
  return staleAcceptanceResult(await loadAggregate(db, "task", taskId));
}

async function markAcceptanceNeedsInfo({ db, taskId, jobId, reason }) {
  const aggregate = await loadAggregate(db, "task", taskId);
  if (aggregate.state !== "accepting") return false;
  try {
    await dispatchCommand({
      db,
      command: parseCommandEnvelope({
        id: `acceptance-needs-info-${jobId}`,
        type: "development_needs_info",
        aggregateType: "task",
        aggregateId: taskId,
        expectedVersion: aggregate.version + 1,
        actorId: "runner-acceptor",
        issuedAt: new Date().toISOString(),
        reason,
        parameters: {},
      }),
      now: new Date().toISOString(),
    });
    return true;
  } catch {
    return false;
  }
}

async function parkAcceptanceForCommentMedia({ db, client, taskId, jobId, reason }) {
  const transitioned = await markAcceptanceNeedsInfo({ db, taskId, jobId, reason });
  if (!transitioned) return staleAcceptanceResult(await loadAggregate(db, "task", taskId));
  try {
    await client.postComment(
      taskId,
      `⚠️ 验收无法读取评论图片：${reason}\n请重新上传或补充评论，然后把任务状态改回「开发中」。`,
    );
  } catch {
    // 评论失败不掩盖 needs_info 结论
  }
  return {
    status: "failed",
    classification: "needs_info",
    error: `needs_info: ${reason}`,
  };
}

export async function executeAcceptance({
  job,
  db,
  client,
  codex,
  now,
  fieldIds = { feedback: null },
}) {
  const { taskId, acceptanceCriteria, commitSha } = job.payload;
  try {
    const startAggregate = await loadAggregate(db, "task", taskId);
    if (startAggregate.state !== "accepting") return staleAcceptanceResult(startAggregate);
    if (
      Number.isInteger(job.payload.aggregateVersion)
      && startAggregate.version !== job.payload.aggregateVersion
    ) {
      return staleAcceptanceResult(startAggregate);
    }
    const executionVersion = startAggregate.version;
    const task = await client.getTask(taskId);
    let mediaBundle;
    try {
      const comments = await client.getComments(taskId);
      mediaBundle = await collectCommentMedia({ comments, client, taskId });
    } catch (error) {
      return parkAcceptanceForCommentMedia({
        db,
        client,
        taskId,
        jobId: job.id,
        reason: formatCommentMediaError(error),
      });
    }
    // 验收开始：任务保持「开发中」，通过后直接进入「待测试」
    let activity;
    let run;
    let runError;
    let codexStarted = false;
    try {
      activity = await currentAcceptance(db, taskId, executionVersion);
      if (!activity.active) return staleAcceptanceResult(activity.aggregate);
      const diagnosticComment = formatCommentMediaDiagnostics(mediaBundle.diagnostics);
      if (diagnosticComment) {
        try {
          await client.postComment(taskId, diagnosticComment);
        } catch {
          // 截断诊断评论失败不影响已保留图片的验收
        }
      }
      codexStarted = true;
      run = await codex.run({
        prompt: buildAcceptancePrompt(task, acceptanceCriteria, commitSha, mediaBundle.textContext),
        workdir: job.payload.workdir,
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
      return parkAcceptanceForCommentMedia({
        db,
        client,
        taskId,
        jobId: job.id,
        reason: decodeReason,
      });
    }
    if (runError) {
      const safeFailure = codexStarted
        ? formatCodexMediaRunFailure(runError, mediaBundle.images)
        : null;
      if (safeFailure) throw new Error(safeFailure);
      throw runError;
    }
    activity = await currentAcceptance(db, taskId, executionVersion);
    if (!activity.active) return staleAcceptanceResult(activity.aggregate);
    if (run.exitCode !== 0) {
      return {
        status: "failed",
        error: formatCodexMediaRunFailure(run, mediaBundle.images)
          ?? `codex exited ${run.exitCode}: ${run.stderr}`,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(extractJson(run.stdout));
    } catch {
      return { status: "failed", error: "invalid JSON output" };
    }
    if (parsed.acceptance_result !== "accepted" && parsed.acceptance_result !== "rejected") {
      return { status: "failed", error: "missing acceptance_result" };
    }

    const targetVersion = task.custom_fields?.find(
      (field) => field.name === "目标版本" || field.id === "field-version",
    )?.value ?? null;

    if (parsed.acceptance_result === "accepted") {
      if (!targetVersion) {
        return { status: "failed", error: "task has no target version" };
      }
      activity = await currentAcceptance(db, taskId, executionVersion);
      if (!activity.active) return staleAcceptanceResult(activity.aggregate);
      const remotePause = await pauseForRemoteWaitingInfo({
        db,
        client,
        taskId,
        jobId: job.id,
      });
      if (remotePause) return remotePause;
      activity = await currentAcceptance(db, taskId, executionVersion);
      if (!activity.active) return staleAcceptanceResult(activity.aggregate);
      try {
        await client.postComment(taskId, "✅ 代码自动验收通过，正在合并并部署测试环境");
      } catch {
        // 评论失败不影响验收结果
      }
      try {
        await resetRework({ db, taskId });
      } catch {
        // 返工计数重置失败不影响验收结果
      }
      return {
        status: "completed",
        result: "accepted",
        commitSha,
        targetVersion,
        findings: [],
      };
    }

    const findings = parsed.findings ?? [];
    activity = await currentAcceptance(db, taskId, executionVersion);
    if (!activity.active) return staleAcceptanceResult(activity.aggregate);
    const { blocked } = await recordFailure({
      db,
      taskId,
      reason: "acceptance failed",
      evidence: `acceptance-${job.id}`,
      now: new Date().toISOString(),
    });
    activity = await currentAcceptance(db, taskId, executionVersion);
    if (!activity.active) return staleAcceptanceResult(activity.aggregate);
    const outcome = blocked
      ? "验收已连续多次不通过，已转为「验收不通过」；请确认原因后手动把状态改回「待开发」或「待测试」。"
      : "已退回待开发，系统将自动重新开发。";
    const feedbackText = `${formatFullAcceptanceFeedback(findings)}

${outcome}`;
    await client.postComment(
      taskId,
      `${formatAcceptanceFeedback(findings)}

${outcome}`,
    );
    activity = await currentAcceptance(db, taskId, executionVersion);
    if (!activity.active) return staleAcceptanceResult(activity.aggregate);
    if (fieldIds.feedback) {
      try {
        await client.updateCustomField(taskId, fieldIds.feedback, feedbackText);
      } catch {
        // 字段写入失败不影响验收结果
      }
      activity = await currentAcceptance(db, taskId, executionVersion);
      if (!activity.active) return staleAcceptanceResult(activity.aggregate);
    }
    const aggregate = activity.aggregate;
    const command = parseCommandEnvelope({
      id: `acceptance-${job.id}`,
      type: blocked ? "acceptance_rejected" : "acceptance_failed",
      aggregateType: "task",
      aggregateId: taskId,
      expectedVersion: aggregate.version + 1,
      actorId: "runner-acceptor",
      issuedAt: new Date().toISOString(),
      reason: blocked ? "acceptance rejected after repeated failures" : "acceptance failed",
      parameters: { evidenceId: `acceptance-${job.id}` },
    });
    const result = await dispatchCommand({ db, command, now: new Date().toISOString() });
    return {
      status: "completed",
      commandId: result.commandId,
      result: "rejected",
      findings,
    };
  } catch (error) {
    return { status: "failed", error: error.message };
  }
}

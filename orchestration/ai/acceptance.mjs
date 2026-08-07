import { dispatchCommand } from "../application/dispatch-command.mjs";
import {
  recordFailure,
  resetRework,
} from "../application/failure-handler.mjs";
import { parseCommandEnvelope } from "../domain/commands.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import { buildAcceptancePrompt, buildCommentContext } from "./prompts.mjs";

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
    const task = await client.getTask(taskId);
    let commentContext = null;
    try {
      commentContext = buildCommentContext(await client.getComments(taskId));
    } catch {}
    // 验收开始：任务保持「开发中」，通过后直接进入「待测试」
    let aggregate = await loadAggregate(db, "task", taskId);
    const run = await codex.run({
      prompt: buildAcceptancePrompt(task, acceptanceCriteria, commitSha, commentContext),
      workdir: job.payload.workdir,
      taskId,
    });
    if (run.exitCode !== 0) {
      return { status: "failed", error: `codex exited ${run.exitCode}: ${run.stderr}` };
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
      const command = parseCommandEnvelope({
        id: `acceptance-${job.id}`,
        type: "acceptance_passed",
        aggregateType: "task",
        aggregateId: taskId,
        expectedVersion: aggregate.version + 1,
        actorId: "runner-acceptor",
        issuedAt: now,
        reason: "acceptance passed",
        parameters: { targetVersion },
      });
      const result = await dispatchCommand({ db, command, now });
      try {
        await client.postComment(taskId, "✅ 开发完成（自动验收通过），进入待测试");
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
        commandId: result.commandId,
        result: "accepted",
        findings: [],
      };
    }

    const findings = parsed.findings ?? [];
    const { blocked } = await recordFailure({
      db,
      taskId,
      reason: "acceptance failed",
      evidence: `acceptance-${job.id}`,
      now,
    });
    const outcome = blocked
      ? "验收已连续多次不通过，已暂停自动返工；请确认原因后把状态改回「开发中」重新开发。"
      : "已退回待开发，系统将自动重新开发。";
    const feedbackText = `${formatFullAcceptanceFeedback(findings)}

${outcome}`;
    await client.postComment(
      taskId,
      `${formatAcceptanceFeedback(findings)}

${outcome}`,
    );
    if (fieldIds.feedback) {
      try {
        await client.updateCustomField(taskId, fieldIds.feedback, feedbackText);
      } catch {
        // 字段写入失败不影响验收结果
      }
    }
    const command = parseCommandEnvelope({
      id: `acceptance-${job.id}`,
      type: "acceptance_failed",
      aggregateType: "task",
      aggregateId: taskId,
      expectedVersion: aggregate.version + 1,
      actorId: "runner-acceptor",
      issuedAt: now,
      reason: "acceptance failed",
      parameters: { evidenceId: `acceptance-${job.id}` },
    });
    const result = await dispatchCommand({ db, command, now });
    if (blocked) {
      await db
        .prepare(`
          INSERT OR IGNORE INTO runner_jobs (
            id, command_id, job_type, payload, payload_hash, status, result, created_at, completed_at
          ) VALUES (?, ?, 'accept', ?, 'paused', 'failed', ?, ?, ?)
        `)
        .bind(
          "acceptance-paused-" + taskId,
          "auto-accept-" + taskId,
          JSON.stringify({ taskId }),
          JSON.stringify({ error: "acceptance_paused" }),
          now,
          now,
        )
        .run();
    }
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

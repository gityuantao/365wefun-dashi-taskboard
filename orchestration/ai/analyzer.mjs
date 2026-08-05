import { dispatchCommand } from "../application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../domain/commands.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import { buildAnalysisPrompt } from "./prompts.mjs";

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

async function markNeedsHuman({ db, taskId, jobId, now, reason }) {
  const aggregate = await loadAggregate(db, "task", taskId);
  if (aggregate.state !== "analyzing") return;
  const command = parseCommandEnvelope({
    id: `analysis-needs-human-${jobId}`,
    type: "analysis_needs_human",
    aggregateType: "task",
    aggregateId: taskId,
    expectedVersion: aggregate.version + 1,
    actorId: "runner-analyzer",
    issuedAt: now,
    reason,
    parameters: {},
  });
  try {
    await dispatchCommand({ db, command, now });
  } catch (error) {
    // 状态推进失败不掩盖 needs_human 结论；下一次恢复流程仍可处理
  }
}

export async function executeAnalysis({
  job,
  db,
  client,
  codex,
  now,
  fieldIds = { summary: "field-summary" },
}) {
  const task = await client.getTask(job.payload.taskId);
  const run = await codex.run({
    prompt: buildAnalysisPrompt(task),
    workdir: job.payload.workdir,
    taskId: job.payload.taskId,
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
  if (
    typeof parsed.scope !== "string"
    || parsed.scope === ""
    || !Array.isArray(parsed.acceptance_criteria)
    || parsed.acceptance_criteria.length === 0
  ) {
    return { status: "failed", error: "missing scope or acceptance_criteria" };
  }
  if (Array.isArray(parsed.open_questions) && parsed.open_questions.length > 0) {
    await markNeedsHuman({ db, taskId: task.id, jobId: job.id, now, reason: "analysis needs human input" });
    try {
      await client.postComment(
        task.id,
        [
          "需要补充信息才能继续分析，请回复：",
          ...parsed.open_questions.map((question, index) => `${index + 1}. ${concise(question.question, 80)}`),
          "回复后请把任务状态改回「分析中」，我会自动重新分析。",
        ].join("\n"),
      );
    } catch {
      // 评论失败不掩盖 needs_human 结论
    }
    return {
      status: "failed",
      error: "needs_human: open questions require human input",
      openQuestions: parsed.open_questions,
    };
  }
  const targetVersion = task.custom_fields?.find(
    (field) => field.name === "目标版本" || field.id === "field-version",
  )?.value ?? null;
  if (!targetVersion) {
    await markNeedsHuman({ db, taskId: task.id, jobId: job.id, now, reason: "task must be linked to a target version" });
    try {
      await client.postComment(
        task.id,
        "请补充目标版本信息（或留空由我自动分配），然后把任务状态改回「分析中」，我会自动重新分析。",
      );
    } catch {
      // 评论失败不掩盖 needs_human 结论
    }
    return {
      status: "failed",
      error: "needs_human: task must be linked to a target version before analysis can complete",
    };
  }

  await client.postComment(
    task.id,
    `✅ 分析完成：${concise(parsed.scope)}（验收标准 ${parsed.acceptance_criteria.length} 条）`,
  );
  await client.updateCustomField(
    task.id,
    fieldIds.summary,
    JSON.stringify({
      scope: parsed.scope,
      acceptance_criteria: parsed.acceptance_criteria,
    }),
  );

  const aggregate = await loadAggregate(db, "task", task.id);
  const command = parseCommandEnvelope({
    id: `analysis-${job.id}`,
    type: "analysis_completed",
    aggregateType: "task",
    aggregateId: task.id,
    expectedVersion: aggregate.version + 1,
    actorId: "runner-analyzer",
    issuedAt: now,
    reason: "analysis completed",
    parameters: {},
  });
  try {
    const result = await dispatchCommand({ db, command, now });
    return {
      status: "completed",
      commandId: result.commandId,
      summary: {
        scope: parsed.scope,
        acceptance_criteria: parsed.acceptance_criteria,
      },
    };
  } catch (error) {
    return { status: "failed", error: error.message };
  }
}

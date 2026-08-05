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
    try {
      await client.postComment(
        task.id,
        [
          "分析需要人工澄清，请补充以下信息（补充后系统会自动重新分析）：",
          ...parsed.open_questions.map((question, index) => `${index + 1}. ${question.question}`),
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
    return {
      status: "failed",
      error: "needs_human: task must be linked to a target version before analysis can complete",
    };
  }

  await client.postComment(
    task.id,
    [
      `分析完成：${parsed.scope}`,
      ...parsed.acceptance_criteria.map((criterion) => `- ${criterion.id}: ${criterion.criterion}（验证：${criterion.verification ?? "未指定"}）`),
    ].join("\n"),
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

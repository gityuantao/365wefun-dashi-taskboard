import { dispatchCommand } from "../application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../domain/commands.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import { buildAcceptancePrompt } from "./prompts.mjs";

function extractJson(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return stdout;
  return stdout.slice(start, end + 1);
}

export async function executeAcceptance({
  job,
  db,
  client,
  codex,
  now,
}) {
  const { taskId, acceptanceCriteria, commitSha } = job.payload;
  try {
    const task = await client.getTask(taskId);
    const run = await codex.run({
      prompt: buildAcceptancePrompt(task, acceptanceCriteria, commitSha),
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

    let aggregate = await loadAggregate(db, "task", taskId);
    if (aggregate.state === "ready_for_acceptance") {
      await dispatchCommand({
        db,
        command: parseCommandEnvelope({
          id: `acceptance-start-${job.id}`,
          type: "start_acceptance",
          aggregateType: "task",
          aggregateId: taskId,
          expectedVersion: aggregate.version + 1,
          actorId: "runner-acceptor",
          issuedAt: now,
          reason: "acceptance started",
          parameters: {},
        }),
        now,
      });
      aggregate = await loadAggregate(db, "task", taskId);
    }
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
      return {
        status: "completed",
        commandId: result.commandId,
        result: "accepted",
      };
    }

    await client.postComment(
      taskId,
      [
        "验收不通过：",
        ...(parsed.findings ?? []).map(
          (finding) => `- [${finding.severity}] ${finding.description}`,
        ),
      ].join("\n"),
    );
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
    return {
      status: "completed",
      commandId: result.commandId,
      result: "rejected",
    };
  } catch (error) {
    return { status: "failed", error: error.message };
  }
}

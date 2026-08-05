import { parseCommandEnvelope } from "../domain/commands.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import { dispatchCommand } from "./dispatch-command.mjs";

const TESTER_ROLES = new Set(["tester", "admin"]);

export async function handleTestDecision({
  db,
  taskId,
  decision,
  evidenceId,
  commandId,
  actorId,
  actorRoles = [],
  now,
}) {
  if (!actorRoles.some((role) => TESTER_ROLES.has(role))) {
    return { status: "rejected", error: "UNAUTHORIZED: tester role required" };
  }
  const aggregate = await loadAggregate(db, "task", taskId);
  const command = parseCommandEnvelope({
    id: commandId ?? `test-${taskId}-${aggregate.version + 1}`,
    type: decision === "pass" ? "test_passed" : "test_failed",
    aggregateType: "task",
    aggregateId: taskId,
    expectedVersion: aggregate.version + 1,
    actorId,
    issuedAt: now,
    reason: `test ${decision}`,
    parameters: decision === "fail" ? { evidenceId } : {},
  });
  try {
    const result = await dispatchCommand({ db, command, now });
    return { status: "succeeded", commandId: result.commandId };
  } catch (error) {
    return { status: "failed", error: error.message };
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { handleTestDecision } from "../../orchestration/application/test-gate.mjs";

const NOW = "2026-08-04T00:03:00.000Z";

async function seedToTesting(harness) {
  for (let index = 0; index < 5; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "start_test"][index];
    await dispatchCommand({
      db: harness.db,
      command: parseCommandEnvelope({
        id: `gate-seed-${index}`,
        type,
        aggregateType: "task",
        aggregateId: "task-1",
        expectedVersion: index + 1,
        actorId: "system",
        issuedAt: NOW,
        reason: "seed",
        parameters: {},
      }),
      now: NOW,
    });
  }
}

test("test decision rejects users without tester role", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToTesting(harness);
  const result = await handleTestDecision({
    db: harness.db,
    taskId: "task-1",
    decision: "pass",
    actorId: "user-non-tester",
    actorRoles: ["developer"],
    now: NOW,
  });
  assert.equal(result.status, "rejected");
  assert.match(result.error, /UNAUTHORIZED/);
});

test("test pass advances the task to ready for acceptance", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToTesting(harness);
  const result = await handleTestDecision({
    db: harness.db,
    taskId: "task-1",
    decision: "pass",
    actorId: "tester-1",
    actorRoles: ["tester"],
    now: NOW,
  });
  assert.equal(result.status, "succeeded");
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_acceptance");
});

test("test failure requires evidence and returns to ready for development", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToTesting(harness);
  const missing = await handleTestDecision({
    db: harness.db,
    taskId: "task-1",
    decision: "fail",
    actorId: "tester-1",
    actorRoles: ["tester"],
    now: NOW,
  });
  assert.equal(missing.status, "failed");
  assert.match(missing.error, /EVIDENCE_REQUIRED/);

  const failed = await handleTestDecision({
    db: harness.db,
    taskId: "task-1",
    decision: "fail",
    evidenceId: "ev-test-1",
    actorId: "tester-1",
    actorRoles: ["tester"],
    now: NOW,
  });
  assert.equal(failed.status, "succeeded");
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_development");
});

test("test decision is idempotent for the same command id", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToTesting(harness);
  const options = {
    db: harness.db,
    taskId: "task-1",
    decision: "pass",
    commandId: "gate-command-1",
    actorId: "tester-1",
    actorRoles: ["tester"],
    now: NOW,
  };
  const first = await handleTestDecision(options);
  const second = await handleTestDecision(options);
  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "succeeded");
  const count = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM orchestration_commands")
    .first();
  assert.equal(count.count, 6);
});

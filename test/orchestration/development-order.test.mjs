import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { checkDevelopmentOrder } from "../../orchestration/application/development-order.mjs";

const NOW = "2026-08-04T00:10:00.000Z";
const LIST_ID = "901616314492";

function task(id, { priority = 3, version = "version-1", created = "2026-08-04T00:00:00.000Z" } = {}) {
  return {
    id,
    priority: { priority },
    date_created: created,
    custom_fields: [{ id: "field-version", name: "目标版本", value: version }],
  };
}

async function seedTask(harness, taskId, steps) {
  for (let index = 0; index < steps; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "start_test", "test_passed", "start_acceptance",
      "acceptance_passed"][index];
    await dispatchCommand({
      db: harness.db,
      command: parseCommandEnvelope({
        id: `order-${taskId}-${index}`,
        type,
        aggregateType: "task",
        aggregateId: taskId,
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

function makeClient(current, siblings) {
  return {
    getTask: async () => current,
    getTasksByList: async () => siblings,
  };
}

test("development order blocks when a higher-priority sibling is not developed", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const current = task("task-b", { priority: 2 });
  const sibling = task("task-a", { priority: 1 });
  const client = makeClient(current, [sibling, current]);
  const gate = await checkDevelopmentOrder({
    db: harness.db,
    taskId: "task-b",
    client,
    listId: LIST_ID,
    now: NOW,
  });
  assert.equal(gate.blocked, true);
  assert.match(gate.reason, /task-a/);
});

test("development order allows when the higher-priority sibling is developed", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedTask(harness, "task-a", 4); // 到 ready_for_test
  const current = task("task-b", { priority: 2 });
  const sibling = task("task-a", { priority: 1 });
  const client = makeClient(current, [sibling, current]);
  const gate = await checkDevelopmentOrder({
    db: harness.db,
    taskId: "task-b",
    client,
    listId: LIST_ID,
    now: NOW,
  });
  assert.equal(gate.blocked, false);
});

test("development order blocks tasks without a target version", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const current = task("task-b", { version: null });
  const client = makeClient(current, [current]);
  const gate = await checkDevelopmentOrder({
    db: harness.db,
    taskId: "task-b",
    client,
    listId: LIST_ID,
    now: NOW,
  });
  assert.equal(gate.blocked, true);
  assert.match(gate.reason, /no target version/);
});

test("development order ignores siblings in other versions", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const current = task("task-b", { priority: 2 });
  const sibling = task("task-a", { priority: 1, version: "version-2" });
  const client = makeClient(current, [sibling, current]);
  const gate = await checkDevelopmentOrder({
    db: harness.db,
    taskId: "task-b",
    client,
    listId: LIST_ID,
    now: NOW,
  });
  assert.equal(gate.blocked, false);
});

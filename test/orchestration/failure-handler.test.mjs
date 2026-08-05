import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import {
  checkReworkBudget,
  recordFailure,
} from "../../orchestration/application/failure-handler.mjs";

const NOW = "2026-08-04T00:05:00.000Z";

test("recordFailure increments the rework round", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const first = await recordFailure({
    db: harness.db,
    taskId: "task-1",
    reason: "test failed",
    evidence: "ev-1",
    now: NOW,
  });
  assert.equal(first.round, 1);
  assert.equal(first.blocked, false);
  const second = await recordFailure({
    db: harness.db,
    taskId: "task-1",
    reason: "test failed again",
    evidence: "ev-2",
    now: NOW,
  });
  assert.equal(second.round, 2);
});

test("rework budget blocks after three rounds", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 3; index += 1) {
    await recordFailure({
      db: harness.db,
      taskId: "task-2",
      reason: `failure ${index + 1}`,
      evidence: `ev-${index + 1}`,
      now: NOW,
    });
  }
  const budget = await checkReworkBudget({ db: harness.db, taskId: "task-2" });
  assert.equal(budget.round, 3);
  assert.equal(budget.exhausted, true);
  const blocker = await harness.db
    .prepare("SELECT status, type FROM blockers WHERE object_id = ?")
    .bind("task-2")
    .first();
  assert.equal(blocker.status, "open");
  assert.equal(blocker.type, "rework_budget");
});

test("checkReworkBudget returns zero for untouched tasks", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const budget = await checkReworkBudget({ db: harness.db, taskId: "task-3" });
  assert.deepEqual(budget, { round: 0, exhausted: false });
});

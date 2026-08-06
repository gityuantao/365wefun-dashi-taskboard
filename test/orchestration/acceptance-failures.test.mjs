import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import {
  MAX_ACCEPTANCE_FAILURES,
  acceptanceFailureStreak,
  pausedJobId,
} from "../../orchestration/application/acceptance-failures.mjs";

const NOW = "2026-08-04T00:00:10.000Z";

async function insertEvent(harness, { sequence, type, version }) {
  await harness.db
    .prepare(`
      INSERT INTO orchestration_events (
        id, sequence, aggregate_type, aggregate_id, aggregate_version, type,
        command_id, actor_id, occurred_at, data, previous_hash, hash
      ) VALUES (?, ?, 'task', 'task-1', ?, ?, ?, 'system', ?, '{}', ?, ?)
    `)
    .bind(`evt-${sequence}`, sequence, version, type, `cmd-${sequence}`, NOW, `h-${sequence}`, `hash-${sequence}`)
    .run();
}

test("streak counts consecutive acceptance failures and stops at passed", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await insertEvent(harness, { sequence: 1, type: "task.acceptance_failed", version: 3 });
  await insertEvent(harness, { sequence: 2, type: "task.acceptance_failed", version: 5 });
  await insertEvent(harness, { sequence: 3, type: "task.acceptance_passed", version: 6 });

  assert.equal(await acceptanceFailureStreak(harness.db, "task-1"), 0);
  assert.equal(MAX_ACCEPTANCE_FAILURES, 2);
  assert.equal(pausedJobId("task-1"), "acceptance-paused-task-1");
});

test("streak counts consecutive failures without a passed event", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await insertEvent(harness, { sequence: 1, type: "task.acceptance_failed", version: 3 });
  await insertEvent(harness, { sequence: 2, type: "task.acceptance_failed", version: 5 });
  assert.equal(await acceptanceFailureStreak(harness.db, "task-1"), 2);
});

test("streak resets after manual rework", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await insertEvent(harness, { sequence: 1, type: "task.acceptance_failed", version: 3 });
  await insertEvent(harness, { sequence: 2, type: "task.acceptance_failed", version: 5 });
  await insertEvent(harness, { sequence: 3, type: "task.acceptance_needs_rework", version: 6 });
  await insertEvent(harness, { sequence: 4, type: "task.acceptance_failed", version: 8 });

  assert.equal(await acceptanceFailureStreak(harness.db, "task-1"), 1);
});

import assert from "node:assert/strict";
import test from "node:test";

import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { resolveSatisfiedReworkBlockers } from "../../orchestration/application/blocker-reconciliation.mjs";

const NOW = "2026-08-12T06:00:00.000Z";

async function seedReadyTask(db, { blockerAt = "2026-08-12T05:00:00.000Z", successAt = "2026-08-12T05:30:00.000Z" } = {}) {
  await db.prepare(`INSERT INTO clickup_snapshots
    (object_type,object_id,list_id,status,snapshot,fields_hash,read_at)
    VALUES ('task','task-1','task-list','ready_for_release',?,'hash',?)`)
    .bind(JSON.stringify({ id: "task-1", status: "ready_for_release", targetVersion: "v1" }), NOW).run();
  await db.prepare(`INSERT INTO orchestration_aggregates
    (aggregate_type,aggregate_id,aggregate_version,state,snapshot,updated_at)
    VALUES ('task','task-1',7,'ready_for_release',NULL,?)`).bind(NOW).run();
  await db.prepare(`INSERT INTO blockers
    (id,object_type,object_id,type,reason,status,created_at,resolved_at)
    VALUES ('rework','task','task-1','rework_budget','old failure','open',?,NULL),
      ('manual','task','task-1','blocked','manual hold','open',?,NULL)`)
    .bind(blockerAt, blockerAt).run();
  await db.prepare(`INSERT INTO orchestration_events
    (id,sequence,aggregate_type,aggregate_id,aggregate_version,type,command_id,actor_id,occurred_at,data,previous_hash,hash)
    VALUES ('success',1,'task','task-1',7,'task.test_passed','test-pass','system-poller',?,'{}',NULL,?)`)
    .bind(successAt, `hash-${successAt}`).run();
}

test("a later authoritative test success resolves only the open rework blocker and is idempotent", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedReadyTask(harness.db);

  const dryRun = await resolveSatisfiedReworkBlockers({ db: harness.db, taskId: "task-1", now: NOW, dryRun: true });
  assert.deepEqual(dryRun, { eligible: [{ blockerId: "rework", evidenceId: "success" }], resolved: [], skipped: [] });
  assert.equal((await harness.db.prepare("SELECT status FROM blockers WHERE id='rework'").first()).status, "open");

  const applied = await resolveSatisfiedReworkBlockers({ db: harness.db, taskId: "task-1", now: NOW, dryRun: false });
  assert.deepEqual(applied.resolved, [{ blockerId: "rework", evidenceId: "success" }]);
  const rows = (await harness.db.prepare("SELECT id,status,resolved_at FROM blockers ORDER BY id").all()).results;
  assert.deepEqual(rows, [
    { id: "manual", status: "open", resolved_at: null },
    { id: "rework", status: "resolved", resolved_at: NOW },
  ]);
  assert.deepEqual((await resolveSatisfiedReworkBlockers({ db: harness.db, taskId: "task-1", now: NOW, dryRun: false })).resolved, []);
});

test("success before the blocker, snapshot-only readiness, and non-ready aggregate stay open", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedReadyTask(harness.db, { blockerAt: "2026-08-12T05:30:00.000Z", successAt: "2026-08-12T05:00:00.000Z" });
  let result = await resolveSatisfiedReworkBlockers({ db: harness.db, taskId: "task-1", now: NOW, dryRun: false });
  assert.deepEqual(result.resolved, []);
  await harness.db.prepare("UPDATE orchestration_aggregates SET state='ready_for_test' WHERE aggregate_id='task-1'").run();
  result = await resolveSatisfiedReworkBlockers({ db: harness.db, taskId: "task-1", now: NOW, dryRun: false });
  assert.deepEqual(result.resolved, []);
  assert.equal((await harness.db.prepare("SELECT status FROM blockers WHERE id='rework'").first()).status, "open");
});

test("an audited release approval satisfies an older rework blocker", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedReadyTask(harness.db);
  await harness.db.prepare("UPDATE orchestration_events SET type='task.release_approved' WHERE id='success'").run();

  const result = await resolveSatisfiedReworkBlockers({
    db: harness.db, taskId: "task-1", now: NOW, dryRun: false,
  });
  assert.deepEqual(result.resolved, [{ blockerId: "rework", evidenceId: "success" }]);
});

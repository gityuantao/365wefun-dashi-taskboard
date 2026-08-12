import assert from "node:assert/strict";
import test from "node:test";

import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { reconcileReleaseReadiness } from "../../scripts/reconcile-release-readiness.mjs";

const NOW = "2026-08-12T08:00:00.000Z";

async function seed(db) {
  const version = { id: "v1", name: "v1.0.3", status: "active", updatedAt: NOW };
  const ready = { id: "ready", name: "ready", status: "ready_for_release", targetVersion: "v1.0.3", platforms: ["ios", "小程序"], updatedAt: NOW };
  const canceled = { id: "canceled", name: "canceled", status: "canceled", targetVersion: "v1.0.3", platforms: ["web"], updatedAt: NOW };
  for (const [type, item] of [["version", version], ["task", ready], ["task", canceled]]) {
    await db.prepare(`INSERT INTO clickup_snapshots
      (object_type,object_id,list_id,status,snapshot,fields_hash,read_at) VALUES (?,?,?,?,?,'hash',?)`)
      .bind(type, item.id, `${type}-list`, item.status, JSON.stringify(item), NOW).run();
  }
  await db.prepare(`INSERT INTO orchestration_aggregates
    (aggregate_type,aggregate_id,aggregate_version,state,snapshot,updated_at)
    VALUES ('version','v1',1,'active',NULL,?),('task','ready',7,'ready_for_release',NULL,?)`).bind(NOW, NOW).run();
  await db.prepare(`INSERT INTO blockers
    (id,object_type,object_id,type,reason,status,created_at,resolved_at)
    VALUES ('block-ready','task','ready','rework_budget','old','open','2026-08-12T06:00:00.000Z',NULL)`).run();
  await db.prepare(`INSERT INTO orchestration_events
    (id,sequence,aggregate_type,aggregate_id,aggregate_version,type,command_id,actor_id,occurred_at,data,previous_hash,hash)
    VALUES ('pass-ready',1,'task','ready',7,'task.test_passed','pass','system','2026-08-12T07:00:00.000Z','{}',NULL,'pass-hash')`).run();
}

const runtimeBoundary = {
  readiness: { ready: false, held: true, error: "productionConfigPath does not exist" },
  configuredApps: [{ id: "au", name: "AU", appStoreAppId: "1", scheme: "AU", bundleId: "example.au" }],
};

test("readiness reconciliation defaults to zero writes and reports exact safe diagnostics", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seed(harness.db);
  const result = await reconcileReleaseReadiness({ db: harness.db, versionId: "v1", runtimeBoundary, now: NOW });
  assert.deepEqual(result.excludedCanceledTaskIds, ["canceled"]);
  assert.deepEqual(result.blockers.eligible, [{ taskId: "ready", blockerId: "block-ready", evidenceId: "pass-ready" }]);
  assert.deepEqual(result.configuredIosApps, [{ id: "au", name: "AU", appStoreAppId: "1", scheme: "AU", bundleId: "example.au" }]);
  assert.equal(result.held, true);
  assert.match(result.runtimeError, /productionConfigPath/);
  assert.ok(result.releaseReadiness.gaps.some((gap) => gap.includes("mini_program")));
  assert.equal((await harness.db.prepare("SELECT status FROM blockers WHERE id='block-ready'").first()).status, "open");
});

test("exact-version blocker apply is idempotent and changes no unrelated release data", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seed(harness.db);
  await assert.rejects(reconcileReleaseReadiness({ db: harness.db, versionId: "wrong", runtimeBoundary, applyBlockers: true, now: NOW }), /version not found/);
  const first = await reconcileReleaseReadiness({ db: harness.db, versionId: "v1", runtimeBoundary, applyBlockers: true, now: NOW });
  assert.deepEqual(first.blockers.resolved, [{ taskId: "ready", blockerId: "block-ready", evidenceId: "pass-ready" }]);
  const second = await reconcileReleaseReadiness({ db: harness.db, versionId: "v1", runtimeBoundary, applyBlockers: true, now: NOW });
  assert.deepEqual(second.blockers.resolved, []);
  assert.equal((await harness.db.prepare("SELECT status FROM blockers WHERE id='block-ready'").first()).status, "resolved");
  assert.equal((await harness.db.prepare("SELECT COUNT(*) count FROM production_release_attempts").first()).count, 0);
  assert.equal((await harness.db.prepare("SELECT COUNT(*) count FROM runner_jobs").first()).count, 0);
});

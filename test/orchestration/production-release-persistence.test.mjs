import assert from "node:assert/strict";
import test from "node:test";

import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";

async function tableColumns(db, table) {
  const result = await db.prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`).bind(table).all();
  return result.results.map(({ name }) => name);
}

async function tableIndexes(db, table) {
  const result = await db.prepare(`SELECT name FROM pragma_index_list(?) ORDER BY name`).bind(table).all();
  return result.results.map(({ name }) => name);
}

test("production release persistence records exact version and target identities with operational evidence", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());

  assert.deepEqual(await tableColumns(harness.db, "production_release_attempts"), [
    "version_id",
    "candidate_commit",
    "manifest_id",
    "attempt",
    "idempotency_key",
    "status",
    "started_at",
    "completed_at",
    "created_at",
    "updated_at",
    "failure_fingerprint",
  ]);
  assert.deepEqual(await tableColumns(harness.db, "production_release_targets"), [
    "version_id",
    "candidate_commit",
    "manifest_id",
    "platform",
    "app_id",
    "attempt",
    "stage",
    "status",
    "external_request_id",
    "upload_id",
    "review_id",
    "live_id",
    "sanitized_observed_evidence",
    "failure_fingerprint",
    "started_at",
    "completed_at",
    "created_at",
    "updated_at",
  ]);
  assert.deepEqual(await tableIndexes(harness.db, "production_release_targets"), [
    "idx_production_release_targets_latest",
    "idx_production_release_targets_reusable_success",
    "sqlite_autoindex_production_release_targets_1",
  ]);
});

test("production release persistence accepts only defined stages and statuses", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const validAttempt = "INSERT INTO production_release_attempts (version_id, candidate_commit, manifest_id, attempt, idempotency_key, status, started_at, created_at, updated_at) VALUES ('v1', 'candidate-1', 'manifest-1', 1, 'idempotency-1', 'running', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');";
  await harness.db.exec(validAttempt);

  await assert.rejects(
    () => harness.db.exec(validAttempt.replace("'running'", "'unknown'")),
    /CHECK constraint failed/,
  );
  await assert.rejects(
    () => harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_id, platform, app_id, attempt, stage, status, started_at, created_at, updated_at) VALUES ('v1', 'candidate-1', 'manifest-1', 'web', '', 1, 'not-a-stage', 'running', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');"),
    /CHECK constraint failed/,
  );
  await harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_id, platform, app_id, attempt, stage, status, sanitized_observed_evidence, started_at, created_at, updated_at) VALUES ('v1', 'candidate-1', 'manifest-1', 'ios', 'au', 1, 'live_readback', 'succeeded', '{\"confirmed\":true}', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');");
});

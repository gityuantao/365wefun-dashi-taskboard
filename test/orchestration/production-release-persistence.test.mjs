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
    "manifest_checksum",
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
    "manifest_checksum",
    "platform",
    "app_id",
    "attempt",
    "stage",
    "status",
    "artifact_identity",
    "production_readback_sha",
    "production_release_id",
    "app_store_app_id",
    "bundle_id",
    "marketing_version",
    "build_number",
    "processing_status",
    "processing_id",
    "review_status",
    "upload_id",
    "review_id",
    "release_status",
    "release_id",
    "live_status",
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

test("production release persistence binds exact checksum identity and accepts only legal platform stages", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const validAttempt = "INSERT INTO production_release_attempts (version_id, candidate_commit, manifest_checksum, attempt, idempotency_key, status, started_at, created_at, updated_at) VALUES ('v1', 'candidate-1', 'checksum-1', 1, 'idempotency-1', 'running', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');";
  await harness.db.exec(validAttempt);

  await assert.rejects(
    () => harness.db.exec(validAttempt.replace("'running'", "'unknown'")),
    /CHECK constraint failed/,
  );
  await assert.rejects(
    () => harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, started_at, created_at, updated_at) VALUES ('v1', 'candidate-1', 'checksum-1', 'web', '', 1, 'review_wait', 'running', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');"),
    /CHECK constraint failed/,
  );
  await assert.rejects(
    () => harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, started_at, created_at, updated_at) VALUES ('v1', 'candidate-1', 'checksum-1', 'android', '', 1, 'readback', 'running', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');"),
    /CHECK constraint failed/,
  );
  await assert.rejects(
    () => harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, app_store_app_id, bundle_id, marketing_version, build_number, started_at, created_at, updated_at) VALUES ('v1', 'candidate-1', 'checksum-1', 'ios', 'au', 2, 'switch', 'running', '0000000001', 'online.365english.app', '1.2.3', '43', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');"),
    /CHECK constraint failed/,
  );
  await harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, app_store_app_id, bundle_id, marketing_version, build_number, processing_status, processing_id, review_status, upload_id, review_id, release_status, release_id, live_status, live_id, sanitized_observed_evidence, started_at, created_at, updated_at) VALUES ('v1', 'candidate-1', 'checksum-1', 'ios', 'au', 1, 'live_readback', 'succeeded', '0000000001', 'online.365english.app', '1.2.3', '42', 'processed', 'processing-1', 'approved', 'upload-1', 'review-1', 'released', 'release-1', 'live', 'live-1', '{\"confirmed\":true}', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');");
});

test("production release persistence reuses successful Web/API readback and blocks idempotency or immutable success rewrites", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const attempt = "INSERT INTO production_release_attempts (version_id, candidate_commit, manifest_checksum, attempt, idempotency_key, status, started_at, completed_at, created_at, updated_at) VALUES ('v2', 'candidate-2', 'checksum-2', 1, 'idempotency-2', 'succeeded', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z');";
  await harness.db.exec(attempt);
  await assert.rejects(
    () => harness.db.exec(attempt.replace("'v2'", "'v3'")),
    /UNIQUE constraint failed/,
  );
  await harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, artifact_identity, production_readback_sha, production_release_id, started_at, completed_at, created_at, updated_at) VALUES ('v2', 'candidate-2', 'checksum-2', 'web', '', 1, 'readback', 'succeeded', 'web-artifact-2', 'candidate-2', 'web-release-2', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z');");
  await harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, artifact_identity, production_readback_sha, production_release_id, started_at, completed_at, created_at, updated_at) VALUES ('v2', 'candidate-2', 'checksum-2', 'api', '', 1, 'readback', 'succeeded', 'api-artifact-2', 'candidate-2', 'api-release-2', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z');");
  const reusable = await harness.db.prepare("SELECT production_release_id FROM production_release_targets INDEXED BY idx_production_release_targets_reusable_success WHERE version_id = ? AND candidate_commit = ? AND manifest_checksum = ? AND platform = ? AND app_id = ? AND status = 'succeeded' AND ((platform IN ('web', 'api') AND stage = 'readback') OR (platform = 'ios' AND stage = 'live_readback'))").bind('v2', 'candidate-2', 'checksum-2', 'web', '').all();
  assert.deepEqual(reusable.results, [{ production_release_id: "web-release-2" }]);
  const reusableApi = await harness.db.prepare("SELECT production_release_id FROM production_release_targets INDEXED BY idx_production_release_targets_reusable_success WHERE version_id = ? AND candidate_commit = ? AND manifest_checksum = ? AND platform = ? AND app_id = ? AND status = 'succeeded' AND ((platform IN ('web', 'api') AND stage = 'readback') OR (platform = 'ios' AND stage = 'live_readback'))").bind('v2', 'candidate-2', 'checksum-2', 'api', '').all();
  assert.deepEqual(reusableApi.results, [{ production_release_id: "api-release-2" }]);
  await assert.rejects(
    () => harness.db.exec("UPDATE production_release_attempts SET updated_at = '2026-08-11T00:02:00.000Z' WHERE version_id = 'v2'"),
    /immutable/,
  );
  await assert.rejects(
    () => harness.db.exec("UPDATE production_release_targets SET production_release_id = 'other' WHERE version_id = 'v2'"),
    /immutable/,
  );
});

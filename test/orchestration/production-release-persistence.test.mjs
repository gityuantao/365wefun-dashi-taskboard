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
    "external_request_id",
    "reconciliation_status",
    "failure_classification",
    "sanitized_error_summary",
    "artifact_identity",
    "production_readback_sha",
    "production_release_id",
    "health_status",
    "readback_status",
    "app_store_app_id",
    "bundle_id",
    "marketing_version",
    "build_number",
    "processing_status",
    "processing_id",
    "review_status",
    "review_submission_id",
    "upload_id",
    "review_id",
    "release_status",
    "release_id",
    "live_status",
    "live_id",
    "live_marketing_version",
    "live_build_number",
    "live_membership_confirmed",
    "sanitized_observed_evidence",
    "sanitized_readback_evidence",
    "sanitized_live_evidence",
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
  await harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, external_request_id, app_store_app_id, bundle_id, marketing_version, build_number, processing_status, processing_id, review_status, review_submission_id, upload_id, review_id, release_status, release_id, live_status, live_id, live_marketing_version, live_build_number, live_membership_confirmed, sanitized_observed_evidence, sanitized_readback_evidence, sanitized_live_evidence, completed_at, started_at, created_at, updated_at) VALUES ('v1', 'candidate-1', 'checksum-1', 'ios', 'au', 1, 'live_readback', 'succeeded', 'request-1', '0000000001', 'online.365english.app', '1.2.3', '42', 'processed', 'processing-1', 'approved', 'review-submission-1', 'upload-1', 'review-1', 'released', 'release-1', 'live', 'live-1', '1.2.3', '42', 1, '{\"confirmed\":true}', '{\"sha\":\"candidate-1\"}', '{\"membership\":true}', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');");
});

test("production release persistence permits iOS test work before a build exists", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());

  await harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, app_store_app_id, bundle_id, marketing_version, started_at, created_at, updated_at) VALUES ('v-prebuild', 'candidate-prebuild', 'checksum-prebuild', 'ios', 'au', 1, 'test', 'running', '0000000001', 'online.365english.app', '1.2.3', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');");
});

test("production release persistence rejects incomplete terminal Web and iOS success rows", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const webIncomplete = "INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, external_request_id, artifact_identity, production_readback_sha, production_release_id, health_status, readback_status, completed_at, started_at, created_at, updated_at) VALUES ('v-incomplete', 'candidate-incomplete', 'checksum-incomplete', 'web', '', 1, 'readback', 'succeeded', 'request-web', '   ', 'candidate-incomplete', 'release-web', 'healthy', 'confirmed', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');";
  await assert.rejects(() => harness.db.exec(webIncomplete), /CHECK constraint failed/);
  const iosIncomplete = "INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, external_request_id, app_store_app_id, bundle_id, marketing_version, build_number, processing_status, processing_id, review_status, review_submission_id, upload_id, release_status, release_id, live_status, live_id, live_marketing_version, live_build_number, completed_at, started_at, created_at, updated_at) VALUES ('v-incomplete', 'candidate-incomplete', 'checksum-incomplete', 'ios', 'au', 1, 'live_readback', 'succeeded', 'request-ios', '0000000001', 'online.365english.app', '1.2.3', '   ', 'processed', 'processing-1', 'approved', 'submission-1', 'upload-1', 'released', 'release-1', 'live', 'live-1', '1.2.3', '42', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');";
  await assert.rejects(() => harness.db.exec(iosIncomplete), /CHECK constraint failed/);
});

test("production release persistence records a bounded unknown outcome without raw response fields", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, external_request_id, reconciliation_status, failure_classification, sanitized_error_summary, artifact_identity, started_at, created_at, updated_at) VALUES ('v-outcome', 'candidate-outcome', 'checksum-outcome', 'web', '', 1, 'upload', 'failed', 'request-outcome', 'unknown_outcome', 'external_unknown', 'request outcome unknown', 'artifact-outcome', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');");
  const row = await harness.db.prepare("SELECT external_request_id, reconciliation_status, failure_classification, sanitized_error_summary FROM production_release_targets WHERE version_id = ?").bind("v-outcome").first();
  assert.deepEqual(row, {
    external_request_id: "request-outcome",
    reconciliation_status: "unknown_outcome",
    failure_classification: "external_unknown",
    sanitized_error_summary: "request outcome unknown",
  });
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
  await harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, external_request_id, artifact_identity, production_readback_sha, production_release_id, health_status, readback_status, sanitized_readback_evidence, started_at, completed_at, created_at, updated_at) VALUES ('v2', 'candidate-2', 'checksum-2', 'web', '', 1, 'readback', 'succeeded', 'request-web-2', 'web-artifact-2', 'candidate-2', 'web-release-2', 'healthy', 'confirmed', '{\"sha\":\"candidate-2\"}', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z');");
  await harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, external_request_id, artifact_identity, production_readback_sha, production_release_id, health_status, readback_status, sanitized_readback_evidence, started_at, completed_at, created_at, updated_at) VALUES ('v2', 'candidate-2', 'checksum-2', 'api', '', 1, 'readback', 'succeeded', 'request-api-2', 'api-artifact-2', 'candidate-2', 'api-release-2', 'healthy', 'confirmed', '{\"sha\":\"candidate-2\"}', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z');");
  const reusable = await harness.db.prepare("SELECT production_release_id FROM production_release_targets WHERE version_id = ? AND candidate_commit = ? AND manifest_checksum = ? AND platform = ? AND app_id = ? AND status = 'succeeded' AND ((platform IN ('web', 'api') AND stage = 'readback') OR (platform = 'ios' AND stage = 'live_readback'))").bind('v2', 'candidate-2', 'checksum-2', 'web', '').all();
  assert.deepEqual(reusable.results, [{ production_release_id: "web-release-2" }]);
  const reusableApi = await harness.db.prepare("SELECT production_release_id FROM production_release_targets WHERE version_id = ? AND candidate_commit = ? AND manifest_checksum = ? AND platform = ? AND app_id = ? AND status = 'succeeded' AND ((platform IN ('web', 'api') AND stage = 'readback') OR (platform = 'ios' AND stage = 'live_readback'))").bind('v2', 'candidate-2', 'checksum-2', 'api', '').all();
  assert.deepEqual(reusableApi.results, [{ production_release_id: "api-release-2" }]);
  await assert.rejects(
    () => harness.db.exec("UPDATE production_release_attempts SET updated_at = '2026-08-11T00:02:00.000Z' WHERE version_id = 'v2'"),
    /immutable/,
  );
  await assert.rejects(
    () => harness.db.exec("UPDATE production_release_targets SET production_release_id = 'other' WHERE version_id = 'v2'"),
    /immutable/,
  );
  await assert.rejects(
    () => harness.db.exec("DELETE FROM production_release_attempts WHERE version_id = 'v2'"),
    /immutable/,
  );
  await assert.rejects(
    () => harness.db.exec("DELETE FROM production_release_targets WHERE version_id = 'v2'"),
    /immutable/,
  );
});

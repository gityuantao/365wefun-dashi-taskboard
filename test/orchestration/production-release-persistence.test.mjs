import assert from "node:assert/strict";
import test from "node:test";

import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import {
  acquireProductionReleaseLease,
  initializeProductionTargets,
  listReusableProductionTargetSuccesses,
  loadLatestProductionTarget,
  updateProductionTarget,
} from "../../orchestration/application/production-release-store.mjs";

async function tableColumns(db, table) {
  const result = await db.prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`).bind(table).all();
  return result.results.map(({ name }) => name);
}

async function tableIndexes(db, table) {
  const result = await db.prepare(`SELECT name FROM pragma_index_list(?) ORDER BY name`).bind(table).all();
  return result.results.map(({ name }) => name);
}

function webApiTerminalSuccessSql({ platform, versionId, candidateCommit, readbackSha }) {
  return `INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, external_request_id, artifact_identity, production_readback_sha, production_release_id, health_status, readback_status, sanitized_observed_evidence, sanitized_readback_evidence, completed_at, started_at, created_at, updated_at) VALUES ('${versionId}', '${candidateCommit}', 'checksum-sha', '${platform}', '', 1, 'readback', 'succeeded', 'request-sha', 'artifact-sha', '${readbackSha}', 'release-sha', 'healthy', 'confirmed', '{"confirmed":true}', '{"confirmed":true}', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');`;
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
    "mini_program_app_id",
    "artifact_digest",
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

test("all-platform schema accepts only frozen mini-program and Android TWA stage identities", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const common = "'v-all', 'candidate-all', 'checksum-all'";

  const insert = (platform, appId, stage, miniProgramAppId, digest) => harness.db.prepare(
    "INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, mini_program_app_id, artifact_digest, started_at, created_at, updated_at) VALUES ('v-all', 'candidate-all', 'checksum-all', ?, ?, 1, ?, 'running', ?, ?, '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')",
  ).bind(platform, appId, stage, miniProgramAppId, digest).run();
  await insert("mini_program", "wechat", "build", "wx1fdac5e27c6b5366", "sha256:mp-artifact");
  await insert("android_twa", "", "artifact", null, "sha256:twa-artifact");
  for (const stage of ["preflight", "switch", "health", "readback", "archive", "processing"]) {
    await assert.rejects(
      () => insert("mini_program", `wechat-${stage}`, stage, "wx1fdac5e27c6b5366", "sha256:mp-artifact"),
      /CHECK constraint failed/,
    );
  }
});

test("mini-program terminal success requires complete reconciliation lineage and evidence", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const terminal = {
    version_id: "v-terminal", candidate_commit: "candidate-terminal", manifest_checksum: "checksum-terminal",
    platform: "mini_program", app_id: "wechat", attempt: 1, stage: "live_readback", status: "succeeded",
    external_request_id: "request-terminal", reconciliation_status: "readback_confirmed",
    mini_program_app_id: "wx1fdac5e27c6b5366", artifact_identity: "artifact-terminal",
    artifact_digest: "sha256:artifact-terminal", upload_id: "upload-terminal",
    review_submission_id: "submission-terminal", review_id: "review-terminal",
    release_id: "release-terminal", live_id: "live-terminal", review_status: "approved",
    release_status: "released", live_status: "live", sanitized_observed_evidence: '{"authoritative":true}',
    sanitized_readback_evidence: '{"confirmed":true}', sanitized_live_evidence: '{"live":true}',
    completed_at: "2026-08-12T00:01:00.000Z", started_at: "2026-08-12T00:00:00.000Z",
    created_at: "2026-08-12T00:00:00.000Z", updated_at: "2026-08-12T00:01:00.000Z",
  };
  async function insertTerminal(versionId, omitted = null) {
    const values = { ...terminal, version_id: versionId };
    if (omitted) values[omitted] = null;
    const columns = Object.keys(values);
    return harness.db.prepare(
      `INSERT INTO production_release_targets (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).bind(...columns.map((column) => values[column])).run();
  }
  await insertTerminal("v-terminal");
  for (const field of [
    "mini_program_app_id", "artifact_digest", "upload_id", "review_submission_id",
    "review_id", "release_id", "live_id", "sanitized_observed_evidence",
    "sanitized_readback_evidence", "sanitized_live_evidence",
  ]) {
    await assert.rejects(
      () => insertTerminal(`v-missing-${field}`, field),
      /CHECK constraint failed|NOT NULL constraint failed/,
    );
  }
  await assert.rejects(
    () => harness.db.exec("UPDATE production_release_targets SET artifact_digest = 'sha256:other' WHERE version_id = 'v-terminal'"),
    /immutable/,
  );
});

test("store rejects target tuples absent from the frozen production target plan", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const now = "2026-08-12T00:00:00.000Z";
  const lease = await acquireProductionReleaseLease({ db: harness.db, versionId: "v-plan", holder: "test", now });
  const manifest = {
    versionId: "v-plan", candidateCommit: "candidate-plan", checksum: "checksum-plan",
    productionTargetPlan: {
      schemaVersion: 2,
      dag: { nodes: [{ id: "mini_program:wechat", platform: "mini_program", appId: "wechat" }], edges: [] },
      miniProgramApps: [{ id: "wechat", appId: "wx1fdac5e27c6b5366" }],
    },
  };

  await assert.rejects(
    () => initializeProductionTargets({
      db: harness.db, manifest, lease, now,
      targets: [{ platform: "mini_program", app: { id: "other", appId: "wx0000000000000000" } }],
    }),
    /frozen.*target plan|target tuple/i,
  );
  assert.equal(
    await harness.db.prepare("SELECT COUNT(*) AS count FROM production_release_targets WHERE version_id = 'v-plan'").first().then((row) => row.count),
    0,
  );
});

test("store keeps the frozen mini-program App ID immutable during completion", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const now = "2026-08-12T00:00:00.000Z";
  const lease = await acquireProductionReleaseLease({ db: harness.db, versionId: "v-frozen-app", holder: "test", now });
  const manifest = {
    versionId: "v-frozen-app", candidateCommit: "candidate", checksum: "checksum",
    productionTargetPlan: {
      dag: { nodes: [{ platform: "mini_program", appId: "wechat" }] },
      miniProgramApps: [{ id: "wechat", appId: "wx1fdac5e27c6b5366" }],
    },
  };
  await initializeProductionTargets({
    db: harness.db, manifest, lease, now,
    targets: [{ platform: "mini_program", app: manifest.productionTargetPlan.miniProgramApps[0] }],
  });
  const target = await loadLatestProductionTarget({ db: harness.db, manifest, platform: "mini_program", appId: "wechat" });

  await assert.rejects(
    () => updateProductionTarget({
      db: harness.db, target, values: { miniProgramAppId: "wx0000000000000000" }, lease, now,
    }),
    /frozen.*App ID|immutable/i,
  );
  assert.equal((await loadLatestProductionTarget({ db: harness.db, manifest, platform: "mini_program", appId: "wechat" })).miniProgramAppId, "wx1fdac5e27c6b5366");
});

test("store rejects reusable mini-program success with the wrong frozen App ID", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const manifest = {
    versionId: "v-reuse-app", candidateCommit: "candidate", checksum: "checksum",
    productionTargetPlan: {
      miniProgramApps: [{ id: "wechat", appId: "wx1fdac5e27c6b5366" }],
    },
  };
  await harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, external_request_id, reconciliation_status, mini_program_app_id, artifact_identity, artifact_digest, upload_id, review_submission_id, review_id, release_id, live_id, review_status, release_status, live_status, sanitized_observed_evidence, sanitized_readback_evidence, sanitized_live_evidence, completed_at, started_at, created_at, updated_at) VALUES ('v-reuse-app', 'candidate', 'checksum', 'mini_program', 'wechat', 1, 'live_readback', 'succeeded', 'request', 'readback_confirmed', 'wx0000000000000000', 'artifact', 'sha256:artifact', 'upload', 'submission', 'review', 'release', 'live', 'approved', 'released', 'live', '{\"authoritative\":true}', '{\"confirmed\":true}', '{\"live\":true}', '2026-08-12T00:01:00.000Z', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-08-12T00:01:00.000Z');");

  await assert.rejects(
    () => listReusableProductionTargetSuccesses({ db: harness.db, manifest }),
    /frozen.*App ID|identity/i,
  );
});

test("mini-program terminal success is immutable and reusable on the exact frozen Candidate", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, external_request_id, reconciliation_status, mini_program_app_id, artifact_identity, artifact_digest, upload_id, review_submission_id, review_id, release_id, live_id, review_status, release_status, live_status, sanitized_observed_evidence, sanitized_readback_evidence, sanitized_live_evidence, completed_at, started_at, created_at, updated_at) VALUES ('v-mp', 'candidate-mp', 'checksum-sha', 'mini_program', 'wechat', 1, 'live_readback', 'succeeded', 'request-mp', 'readback_confirmed', 'wx1fdac5e27c6b5366', 'artifact-mp', 'sha256:artifact-mp', 'upload-mp', 'submission-mp', 'review-mp', 'release-mp', 'live-mp', 'approved', 'released', 'live', '{\"authoritative\":true}', '{\"confirmed\":true}', '{\"live\":true}', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');");
  const reusable = await harness.db.prepare(`SELECT release_id FROM production_release_targets
    WHERE version_id = ? AND candidate_commit = ? AND manifest_checksum = ? AND platform = ? AND app_id = ?
      AND status = 'succeeded' AND stage = 'live_readback'`).bind(
    "v-mp", "candidate-mp", "checksum-sha", "mini_program", "wechat",
  ).all();
  assert.deepEqual(reusable.results, [{ release_id: "release-mp" }]);
  await assert.rejects(
    () => harness.db.exec("UPDATE production_release_targets SET updated_at = '2026-08-11T00:02:00.000Z' WHERE version_id = 'v-mp'"),
    /immutable/,
  );
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

test("production release attempt terminal timestamps and failure fingerprints are coherent", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const base = "version_id, candidate_commit, manifest_checksum, attempt, idempotency_key, status, started_at, completed_at, created_at, updated_at, failure_fingerprint";
  for (const values of [
    "'v-success-null', 'candidate', 'checksum', 1, 'key-success-null', 'succeeded', '2026-08-11T00:00:00.000Z', NULL, '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', NULL",
    "'v-success-failure', 'candidate', 'checksum', 1, 'key-success-failure', 'succeeded', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z', 'failure-sha'",
    "'v-failed-null', 'candidate', 'checksum', 1, 'key-failed-null', 'failed', '2026-08-11T00:00:00.000Z', NULL, '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', 'failure-sha'",
    "'v-running-complete', 'candidate', 'checksum', 1, 'key-running-complete', 'running', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z', NULL",
  ]) {
    await assert.rejects(
      () => harness.db.exec(`INSERT INTO production_release_attempts (${base}) VALUES (${values});`),
      /CHECK constraint failed/,
    );
  }
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

for (const platform of ["web", "api"]) {
  test(`production release persistence requires exact ${platform.toUpperCase()} Candidate readback`, async (t) => {
    const harness = await createCloudWorkerHarness();
    t.after(() => harness.dispose());

    await assert.rejects(
      () => harness.db.exec(webApiTerminalSuccessSql({
        platform,
        versionId: `v-${platform}-mismatch`,
        candidateCommit: `candidate-${platform}`,
        readbackSha: `other-${platform}`,
      })),
      /CHECK constraint failed/,
    );
    await harness.db.exec(webApiTerminalSuccessSql({
      platform,
      versionId: `v-${platform}-equal`,
      candidateCommit: `candidate-${platform}`,
      readbackSha: `candidate-${platform}`,
    }));
    const row = await harness.db
      .prepare("SELECT candidate_commit, production_readback_sha FROM production_release_targets WHERE version_id = ?")
      .bind(`v-${platform}-equal`)
      .first();
    assert.deepEqual(row, {
      candidate_commit: `candidate-${platform}`,
      production_readback_sha: `candidate-${platform}`,
    });
  });
}

test("production release persistence rejects NULL terminal evidence and upload build identities", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await assert.rejects(
    () => harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, external_request_id, artifact_identity, production_readback_sha, production_release_id, health_status, readback_status, sanitized_observed_evidence, sanitized_readback_evidence, completed_at, started_at, created_at, updated_at) VALUES ('v-null', 'candidate-null', 'checksum-null', 'web', '', 1, 'readback', 'succeeded', 'request-null', NULL, 'candidate-null', 'release-null', 'healthy', 'confirmed', '{\"confirmed\":true}', '{\"sha\":\"candidate-null\"}', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');"),
    /CHECK constraint failed/,
  );
  await assert.rejects(
    () => harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, external_request_id, app_store_app_id, bundle_id, marketing_version, build_number, processing_status, processing_id, review_status, review_submission_id, upload_id, review_id, release_status, release_id, live_status, live_id, live_marketing_version, live_build_number, live_membership_confirmed, sanitized_observed_evidence, sanitized_live_evidence, completed_at, started_at, created_at, updated_at) VALUES ('v-null', 'candidate-null', 'checksum-null', 'ios', 'au', 1, 'live_readback', 'succeeded', 'request-ios-null', '0000000001', 'online.365english.app', '1.2.3', NULL, 'processed', 'processing-1', 'approved', 'submission-1', 'upload-1', 'review-1', 'released', 'release-1', 'live', 'live-1', '1.2.3', '42', 1, '{\"confirmed\":true}', '{\"membership\":true}', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');"),
    /CHECK constraint failed/,
  );
  await assert.rejects(
    () => harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, app_store_app_id, bundle_id, marketing_version, build_number, started_at, created_at, updated_at) VALUES ('v-null', 'candidate-null', 'checksum-null', 'ios', 'au', 2, 'upload', 'running', '0000000001', 'online.365english.app', '1.2.3', NULL, '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');"),
    /CHECK constraint failed/,
  );
});

test("production release persistence limits success to reconciled terminal stages", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await assert.rejects(
    () => harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, artifact_identity, started_at, created_at, updated_at) VALUES ('v-lifecycle', 'candidate-lifecycle', 'checksum-lifecycle', 'web', '', 1, 'upload', 'succeeded', 'artifact-lifecycle', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');"),
    /CHECK constraint failed/,
  );
  await assert.rejects(
    () => harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, external_request_id, reconciliation_status, artifact_identity, production_readback_sha, production_release_id, health_status, readback_status, sanitized_observed_evidence, sanitized_readback_evidence, completed_at, started_at, created_at, updated_at) VALUES ('v-lifecycle', 'candidate-lifecycle', 'checksum-lifecycle', 'web', '', 2, 'readback', 'succeeded', 'request-lifecycle', 'unknown_outcome', 'artifact-lifecycle', 'candidate-lifecycle', 'release-lifecycle', 'healthy', 'confirmed', '{\"confirmed\":true}', '{\"sha\":\"candidate-lifecycle\"}', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');"),
    /CHECK constraint failed/,
  );
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
  await harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, external_request_id, artifact_identity, production_readback_sha, production_release_id, health_status, readback_status, sanitized_observed_evidence, sanitized_readback_evidence, started_at, completed_at, created_at, updated_at) VALUES ('v2', 'candidate-2', 'checksum-2', 'web', '', 1, 'readback', 'succeeded', 'request-web-2', 'web-artifact-2', 'candidate-2', 'web-release-2', 'healthy', 'confirmed', '{\"confirmed\":true}', '{\"sha\":\"candidate-2\"}', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z');");
  await harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, external_request_id, artifact_identity, production_readback_sha, production_release_id, health_status, readback_status, sanitized_observed_evidence, sanitized_readback_evidence, started_at, completed_at, created_at, updated_at) VALUES ('v2', 'candidate-2', 'checksum-2', 'api', '', 1, 'readback', 'succeeded', 'request-api-2', 'api-artifact-2', 'candidate-2', 'api-release-2', 'healthy', 'confirmed', '{\"confirmed\":true}', '{\"sha\":\"candidate-2\"}', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:01:00.000Z');");
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

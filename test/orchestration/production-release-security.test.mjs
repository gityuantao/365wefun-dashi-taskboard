import assert from "node:assert/strict";
import test from "node:test";

import { executeProductionRelease } from "../../orchestration/application/production-release-coordinator.mjs";
import { createAppStoreReleaseAdapter } from "../../orchestration/ios/app-store-release-adapter.mjs";
import { createReleaseAdapter } from "../../orchestration/release/production-command-adapter.mjs";
import { startDashboardServer } from "../../orchestration/dashboard/http-server.mjs";
import { saveSnapshot } from "../../orchestration/clickup/snapshot.mjs";
import { coordinateReleaseSnapshot } from "../../orchestration/application/release-coordinator.mjs";
import { freezeManifest } from "../../orchestration/release/version-aggregator.mjs";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";

const NOW = "2026-08-12T00:00:00.000Z";
const SHA = "1111111111111111111111111111111111111111";
const MANIFEST = {
  versionId: "v-security",
  candidateCommit: SHA,
  checksum: "manifest-security",
  artifactIdentity: { digest: "sha256:security" },
};
const SECRET_PARTS = [
  "url-user", "url-pass", "bearer-secret", "cookie-secret", "jwt-secret",
  "quoted-secret", "ASC_PRIVATE_FRAGMENT_123456789", "raw-control-secret",
];
const HOSTILE_PARTS = [
  "https://url-user:url-pass@example.invalid/path",
  "Authorization: Bearer bearer-secret",
  "Cookie: sid=cookie-secret",
  "eyJhbGciOiJIUzI1NiJ9.jwt-secret.signaturevalue",
  '{"api_key":"quoted-secret"}',
  "key=ASC_PRIVATE_FRAGMENT_123456789",
  "raw-control-secret\u0000\u001b[31m",
  "x".repeat(8_000),
];
const HOSTILE = HOSTILE_PARTS.join(" | ");

function assertSafe(value, { maxLength = Infinity } = {}) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of SECRET_PARTS) assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /[\u0000-\u001f\u007f]/u);
  assert.ok(serialized.length <= maxLength, `safe value exceeded ${maxLength}: ${serialized.length}`);
}

test("Web command boundary removes credentials, controls, and oversized errors", async () => {
  for (const hostile of HOSTILE_PARTS) {
    const adapter = createReleaseAdapter({
      runtime: {
        productionReleaseCommand: ["node", "fake-production-command.mjs"],
        productionReleaseTimeoutMs: 1_000,
        productionConfigPath: "/private/production.json",
      },
      projectRoot: "/repo",
      runCommand: async () => { throw new Error(hostile); },
    });
    await assert.rejects(adapter.collectRegressionEvidence(MANIFEST), (error) => {
      assertSafe(error.message, { maxLength: 1_100 });
      return true;
    });
  }
});

test("Web command success sanitizes regression evidence and rejects unsafe artifact identity", async () => {
  const make = (modeResult) => createReleaseAdapter({
    runtime: {
      productionReleaseCommand: ["node", "fake-production-command.mjs"],
      productionReleaseTimeoutMs: 1_000, productionConfigPath: "/private/production.json",
    },
    projectRoot: "/repo",
    runCommand: async (_file, _args, options) => ({
      stdout: JSON.stringify(modeResult(options.env.PRODUCTION_RELEASE_MODE)),
    }),
  });
  const safe = await make(() => ({ passed: true, log: HOSTILE })).collectRegressionEvidence(MANIFEST);
  assertSafe(safe);
  await assert.rejects(
    make(() => ({ digest: HOSTILE })).identifyArtifact(MANIFEST),
    /unsafe/i,
  );
});

test("App Store command boundary removes credentials, controls, and oversized errors", async () => {
  for (const hostile of HOSTILE_PARTS) {
    const adapter = createAppStoreReleaseAdapter({
      runtime: {
        iosProductionReleaseCommand: ["node", "fake-ios-command.mjs"],
        iosProductionCredentialsPath: "/private/asc.json",
        repoPath: "/repo",
      },
      projectRoot: "/repo",
      runCommand: async () => { throw new Error(hostile); },
    });
    await assert.rejects(adapter.release({
      manifest: MANIFEST,
      app: {
        id: "au", appStoreAppId: "0000000001", scheme: "E365AU", testScheme: "E365AUTests",
        testTarget: "E365AUTests", bundleId: "online.365english.app", marketingVersion: "1.2.3",
        releaseMode: "automatic", reviewConfigurationRef: "app-store-review/au",
      },
      idempotencyKey: "idem-security",
      recordStage: async () => {},
    }), (error) => {
      assertSafe(error.message, { maxLength: 1_100 });
      return true;
    });
  }
});

test("coordinator rejects hostile identity fields instead of collapsing them into valid lineage", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const adapter = {
    release: async () => ({
      externalRequestId: `request-${HOSTILE}`,
      artifactIdentity: MANIFEST.artifactIdentity,
      productionReleaseId: `release-${HOSTILE}`,
      observedEvidence: { commandLog: HOSTILE },
    }),
    readback: async () => ({
      confirmed: true, published: true, status: "published", authoritative: true,
      candidateCommit: SHA, artifactIdentity: MANIFEST.artifactIdentity,
      externalRequestId: `request-${HOSTILE}`, productionReleaseId: `release-${HOSTILE}`,
      healthStatus: "healthy", readbackStatus: "confirmed",
      observedEvidence: { log: HOSTILE }, readbackEvidence: { comment: HOSTILE },
    }),
  };
  const result = await executeProductionRelease({
    db: harness.db,
    manifest: MANIFEST,
    platforms: [{ id: "task-security", platforms: ["web"] }],
    webAdapter: adapter,
    lease: { holder: "security-worker", durationMs: 60_000, now: () => NOW },
    now: NOW,
  });
  assert.equal(result.status, "waiting_external");
  assertSafe(result);
  const rows = await harness.db.prepare(
    "SELECT * FROM production_release_targets WHERE version_id = ?",
  ).bind(MANIFEST.versionId).all();
  assertSafe(rows.results);
});

test("coordinator sanitizes hostile non-identity evidence without changing exact identities", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const adapter = {
    release: async () => ({
      externalRequestId: "request-safe", artifactIdentity: MANIFEST.artifactIdentity,
      productionReleaseId: "release-safe", observedEvidence: { commandLog: HOSTILE },
    }),
    readback: async () => ({
      confirmed: true, published: true, status: "published", authoritative: true,
      candidateCommit: SHA, artifactIdentity: MANIFEST.artifactIdentity,
      externalRequestId: "request-safe", productionReleaseId: "release-safe",
      healthStatus: "healthy", readbackStatus: "confirmed",
      observedEvidence: { log: HOSTILE }, readbackEvidence: { comment: HOSTILE },
    }),
  };
  const result = await executeProductionRelease({
    db: harness.db, manifest: { ...MANIFEST, versionId: "v-security-evidence" },
    platforms: [{ id: "task-security", platforms: ["web"] }], webAdapter: adapter,
    lease: { holder: "security-worker", durationMs: 60_000, now: () => NOW }, now: NOW,
  });
  assert.equal(result.status, "completed");
  assertSafe(result);
  const rows = await harness.db.prepare(
    "SELECT * FROM production_release_targets WHERE version_id = ?",
  ).bind("v-security-evidence").all();
  assertSafe(rows.results);
});

test("coordinator readback exceptions cannot leak controls or credentials into result or D1", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const adapter = {
    release: async () => ({
      externalRequestId: "request-safe", artifactIdentity: MANIFEST.artifactIdentity,
      productionReleaseId: "release-safe", observedEvidence: { upload: "safe" },
    }),
    readback: async () => { throw new Error(HOSTILE); },
  };
  const result = await executeProductionRelease({
    db: harness.db, manifest: { ...MANIFEST, versionId: "v-security-readback" },
    platforms: [{ id: "task-security", platforms: ["web"] }], webAdapter: adapter,
    lease: { holder: "security-worker", durationMs: 60_000, now: () => NOW }, now: NOW,
  });
  assert.equal(result.status, "waiting_external");
  assertSafe(result);
  const rows = await harness.db.prepare(
    "SELECT * FROM production_release_targets WHERE version_id = ?",
  ).bind("v-security-readback").all();
  assertSafe(rows.results);
  await saveSnapshot(harness.db, {
    type: "version",
    snapshot: { id: "v-security-readback", listId: "version-list", name: "v-security-readback", status: "releasing", blocked: false, updatedAt: NOW, fieldsHash: "security-version" },
    readAt: NOW,
  });
  const dashboard = await startDashboardServer({ db: harness.db, port: 0 });
  t.after(() => dashboard.close());
  const response = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/v-security-readback`,
  );
  assert.equal(response.status, 200);
  assertSafe(await response.json());
});

test("release and readback failures stay safe in coordinator logs and ClickUp comments", async (t) => {
  for (const [index, hostile] of HOSTILE_PARTS.entries()) {
    await t.test(`payload ${index + 1}`, async (t) => {
      const harness = await createCloudWorkerHarness();
      t.after(() => harness.dispose());
      const versionId = `v-security-sinks-${index}`;
      const taskId = `task-security-sinks-${index}`;
      await harness.db.batch([
        harness.db.prepare("INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at) VALUES ('version', ?, 1, 'active', NULL, ?)").bind(versionId, NOW),
        harness.db.prepare("INSERT INTO orchestration_events (id, sequence, aggregate_type, aggregate_id, aggregate_version, type, command_id, actor_id, occurred_at, data, previous_hash, hash) VALUES (?, 1, 'version', ?, 1, 'version.activated', ?, 'system', ?, '{}', NULL, ?)").bind(`security-version-event-${index}`, versionId, `security-version-command-${index}`, NOW, "a".repeat(64)),
        harness.db.prepare("INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at) VALUES ('task', ?, 1, 'ready_for_release', NULL, ?)").bind(taskId, NOW),
        harness.db.prepare("INSERT INTO orchestration_events (id, sequence, aggregate_type, aggregate_id, aggregate_version, type, command_id, actor_id, occurred_at, data, previous_hash, hash) VALUES (?, 2, 'task', ?, 1, 'task.test_passed', ?, 'system', ?, '{}', NULL, ?)").bind(`security-task-event-${index}`, taskId, `security-task-command-${index}`, NOW, "b".repeat(64)),
      ]);
      await saveSnapshot(harness.db, {
        type: "task",
        snapshot: { id: taskId, listId: "task-list", name: "security", status: "ready_for_release", targetVersion: versionId, assignee: null, platforms: ["web"], updatedAt: NOW, fieldsHash: `security-task-${index}` },
        readAt: NOW,
      });
      const frozen = await freezeManifest({
        db: harness.db, versionId, versionBranch: `version/${versionId}`, taskIds: [taskId],
        taskPrHeads: [{ taskId, branch: `task/${taskId}`, headCommit: "2222222222222222222222222222222222222222", prNumber: 7, repository: "owner/repo" }],
        candidateCommit: SHA, candidateRef: `refs/heads/release-candidate/${versionId}/${SHA}`,
        artifactIdentity: MANIFEST.artifactIdentity, regressionEvidence: { passed: true, command: "node --test" },
        productionTargetPlan: { schemaVersion: 1, taskPlatforms: [{ taskId, platforms: ["web"] }], platforms: { web: true, api: false, ios: false }, iosApps: [] },
        now: NOW,
      });
      assert.equal(frozen.status, "frozen", JSON.stringify(frozen));
      const logs = [];
      const comments = [];
      let releaseCalls = 0;
      const common = {
        snapshot: { id: versionId, name: versionId, status: "releasing" },
        now: NOW, db: harness.db, productionReadiness: { ready: true },
        adapter: {
          collectRegressionEvidence: async () => ({ passed: true }), identifyArtifact: async () => MANIFEST.artifactIdentity,
          release: async () => { releaseCalls += 1; throw new Error(hostile); },
          readback: async () => { throw new Error(hostile); },
        },
        releaseLease: { holder: `security-sinks-${index}`, durationMs: 60_000, maxReconciliationAttempts: 3, now: () => NOW },
        client: { postComment: async (_id, message) => comments.push(message) },
        runtime: { repoPath: "/repo", worktreesRoot: "/worktrees" }, repository: "owner/repo",
        releaseGitOps: { verifyCandidate: async () => ({ verified: true }) },
        log: (message) => logs.push(message),
      };
      assert.equal((await coordinateReleaseSnapshot(common)).status, "waiting_external");
      assert.equal((await coordinateReleaseSnapshot(common)).status, "waiting_external");
      assert.equal((await coordinateReleaseSnapshot(common)).status, "failed");
      assert.equal(releaseCalls, 1);
      assert.ok(logs.length > 0, "coordinator log sink was not exercised");
      assert.ok(comments.length > 0, "ClickUp comment sink was not exercised");
      for (const value of logs) assertSafe(value, { maxLength: 1_100 });
      for (const value of comments) assertSafe(value, { maxLength: 1_100 });
    });
  }
});

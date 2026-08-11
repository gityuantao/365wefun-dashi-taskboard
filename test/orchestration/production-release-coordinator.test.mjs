import assert from "node:assert/strict";
import test from "node:test";

import { executeProductionRelease } from "../../orchestration/application/production-release-coordinator.mjs";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";

const NOW = "2026-08-11T08:00:00.000Z";
const LATER = "2026-08-11T08:01:00.000Z";
const CANDIDATE_COMMIT = "1111111111111111111111111111111111111111";
const MANIFEST = Object.freeze({
  versionId: "version-1",
  candidateCommit: CANDIDATE_COMMIT,
  checksum: "manifest-checksum-v1",
  artifactIdentity: Object.freeze({ digest: "sha256:artifact-v1" }),
});
const PLATFORMS = Object.freeze([{ id: "task-a", platforms: Object.freeze(["web", "ios"]) }]);
const IOS_APPS = Object.freeze([
  Object.freeze({
    id: "au",
    name: "Overseas",
    enabled: true,
    scheme: "E365AU",
    testScheme: "E365AUTests",
    testTarget: "E365AUTests",
    appStoreAppId: "0000000001",
    bundleId: "online.365english.app",
    testFlightGroup: "Internal Testing",
    buildNumberSource: "app-store-connect",
    releaseMode: "automatic",
    reviewConfigurationRef: "app-store-review/au",
    marketingVersion: "1.2.3",
  }),
  Object.freeze({
    id: "cn",
    name: "China",
    enabled: true,
    scheme: "E365CN",
    testScheme: "E365CNTests",
    testTarget: "E365CNTests",
    appStoreAppId: "0000000002",
    bundleId: "online.365english.china",
    testFlightGroup: "Internal Testing CN",
    buildNumberSource: "app-store-connect",
    releaseMode: "automatic",
    reviewConfigurationRef: "app-store-review/cn",
    marketingVersion: "1.2.3",
  }),
]);

function releaseLease(holder = "release-worker-1", timestamp = NOW) {
  return { holder, durationMs: 60_000, now: () => timestamp };
}

function webReleaseEvidence() {
  return {
    externalRequestId: "web-request-1",
    artifactIdentity: { digest: "sha256:artifact-v1" },
    productionReleaseId: "web-release-1",
    observedEvidence: { upload: "web-upload-1" },
  };
}

function webLiveEvidence() {
  return {
    status: "completed",
    confirmed: true,
    candidateCommit: CANDIDATE_COMMIT,
    artifactIdentity: { digest: "sha256:artifact-v1" },
    externalRequestId: "web-request-1",
    productionReleaseId: "web-release-1",
    healthStatus: "healthy",
    readbackStatus: "confirmed",
    observedEvidence: { releaseId: "web-release-1" },
    readbackEvidence: { sha: CANDIDATE_COMMIT, health: "healthy" },
  };
}

function iosSubmission(app, attempt = 1) {
  return {
    externalRequestId: `${app.id}-request-${attempt}`,
    buildNumber: String(100 + attempt),
    uploadId: `${app.id}-upload-${attempt}`,
    processingStatus: "processed",
    processingId: `${app.id}-processing-${attempt}`,
    reviewStatus: "submitted",
    reviewSubmissionId: `${app.id}-submission-${attempt}`,
    releaseStatus: "not_released",
    liveStatus: "not_live",
    observedEvidence: { appId: app.id, build: String(100 + attempt) },
  };
}

function iosLiveEvidence(app, attempt = 1) {
  return {
    status: "completed",
    externalRequestId: `${app.id}-request-${attempt}`,
    buildNumber: String(100 + attempt),
    uploadId: `${app.id}-upload-${attempt}`,
    processingStatus: "processed",
    processingId: `${app.id}-processing-${attempt}`,
    reviewStatus: "approved",
    reviewSubmissionId: `${app.id}-submission-${attempt}`,
    reviewId: `${app.id}-review-${attempt}`,
    releaseStatus: "released",
    releaseId: `${app.id}-release-${attempt}`,
    liveStatus: "live",
    liveId: `${app.id}-live-${attempt}`,
    liveMarketingVersion: app.marketingVersion,
    liveBuildNumber: String(100 + attempt),
    liveMembershipConfirmed: true,
    observedEvidence: { appId: app.id, build: String(100 + attempt) },
    liveEvidence: { storefront: "live", appId: app.id },
  };
}

async function releaseRows(db) {
  return db.prepare(
    `SELECT attempt, status, completed_at
     FROM production_release_attempts
     WHERE version_id = ? AND candidate_commit = ? AND manifest_checksum = ?
     ORDER BY attempt`,
  ).bind(MANIFEST.versionId, MANIFEST.candidateCommit, MANIFEST.checksum).all();
}

async function targetRows(db) {
  return db.prepare(
    `SELECT platform, app_id, attempt, stage, status, reconciliation_status,
            production_release_id, build_number, live_status
     FROM production_release_targets
     WHERE version_id = ? AND candidate_commit = ? AND manifest_checksum = ?
     ORDER BY platform, app_id, attempt`,
  ).bind(MANIFEST.versionId, MANIFEST.candidateCommit, MANIFEST.checksum).all();
}

test("Web and enabled iOS Apps run sequentially while an external review keeps the release attempt running", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const calls = [];
  let auWaiting = true;
  const webAdapter = {
    release: async ({ manifest, platform }) => {
      calls.push(`${platform}:release:${manifest.checksum}:${manifest.candidateCommit}`);
      return webReleaseEvidence();
    },
    readback: async ({ manifest, platform }) => {
      calls.push(`${platform}:readback:${manifest.checksum}:${manifest.candidateCommit}`);
      return webLiveEvidence();
    },
  };
  const iosAdapter = {
    release: async ({ manifest, app }) => {
      calls.push(`${app.id}:release:${manifest.checksum}:${manifest.candidateCommit}`);
      return iosSubmission(app);
    },
    readback: async ({ manifest, app }) => {
      calls.push(`${app.id}:readback:${manifest.checksum}:${manifest.candidateCommit}`);
      if (app.id === "au" && auWaiting) {
        return {
          status: "waiting_external",
          reviewStatus: "submitted",
          observedEvidence: { appId: app.id, review: "submitted" },
        };
      }
      return iosLiveEvidence(app);
    },
  };

  const first = await executeProductionRelease({
    db: harness.db,
    manifest: MANIFEST,
    platforms: PLATFORMS,
    apps: IOS_APPS,
    webAdapter,
    iosAdapter,
    lease: releaseLease(),
    now: NOW,
  });

  assert.equal(first.status, "waiting_external");
  assert.deepEqual(calls, [
    `web:release:${MANIFEST.checksum}:${CANDIDATE_COMMIT}`,
    `web:readback:${MANIFEST.checksum}:${CANDIDATE_COMMIT}`,
    `au:release:${MANIFEST.checksum}:${CANDIDATE_COMMIT}`,
    `au:readback:${MANIFEST.checksum}:${CANDIDATE_COMMIT}`,
  ]);
  assert.deepEqual((await releaseRows(harness.db)).results, [
    { attempt: 1, status: "running", completed_at: null },
  ]);

  auWaiting = false;
  const second = await executeProductionRelease({
    db: harness.db,
    manifest: MANIFEST,
    platforms: PLATFORMS,
    apps: IOS_APPS,
    webAdapter,
    iosAdapter,
    lease: releaseLease("release-worker-2", LATER),
    now: LATER,
  });

  assert.equal(second.status, "completed");
  assert.deepEqual(second.targets.map(({ platform, appId, reused }) => [platform, appId, reused]), [
    ["web", "", true],
    ["ios", "au", false],
    ["ios", "cn", false],
  ]);
  assert.deepEqual(calls.slice(4), [
    `au:readback:${MANIFEST.checksum}:${CANDIDATE_COMMIT}`,
    `cn:release:${MANIFEST.checksum}:${CANDIDATE_COMMIT}`,
    `cn:readback:${MANIFEST.checksum}:${CANDIDATE_COMMIT}`,
  ]);
  assert.deepEqual((await releaseRows(harness.db)).results, [
    { attempt: 1, status: "succeeded", completed_at: LATER },
  ]);
  assert.deepEqual(
    (await targetRows(harness.db)).results.map(({ platform, app_id, attempt, stage, status }) => (
      [platform, app_id, attempt, stage, status]
    )),
    [
      ["ios", "au", 1, "review_wait", "running"],
      ["ios", "au", 2, "live_readback", "succeeded"],
      ["ios", "cn", 1, "live_readback", "succeeded"],
      ["web", "", 1, "readback", "succeeded"],
    ],
  );
});

test("a retry reuses authoritative terminal successes and retries only the failed target", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const releases = { web: 0, au: 0, cn: 0 };
  let rejectCn = true;
  const webAdapter = {
    release: async () => {
      releases.web += 1;
      return webReleaseEvidence();
    },
    readback: async () => webLiveEvidence(),
  };
  const iosAdapter = {
    release: async ({ app }) => {
      releases[app.id] += 1;
      if (app.id === "cn" && rejectCn) {
        const error = new Error("App Store validation rejected the binary");
        error.deterministic = true;
        error.failureClassification = "product_rework";
        throw error;
      }
      return iosSubmission(app, releases[app.id]);
    },
    readback: async ({ app }) => iosLiveEvidence(app, releases[app.id]),
  };
  const common = {
    db: harness.db,
    manifest: MANIFEST,
    platforms: PLATFORMS,
    apps: IOS_APPS,
    webAdapter,
    iosAdapter,
  };

  const first = await executeProductionRelease({
    ...common,
    lease: releaseLease(),
    now: NOW,
  });
  assert.equal(first.status, "failed");
  assert.deepEqual(releases, { web: 1, au: 1, cn: 1 });

  rejectCn = false;
  const second = await executeProductionRelease({
    ...common,
    lease: releaseLease("release-worker-2", LATER),
    now: LATER,
  });

  assert.equal(second.status, "completed");
  assert.deepEqual(releases, { web: 1, au: 1, cn: 2 });
  assert.deepEqual((await releaseRows(harness.db)).results.map(({ attempt, status }) => [attempt, status]), [
    [1, "failed"],
    [2, "succeeded"],
  ]);
  const rows = (await targetRows(harness.db)).results;
  assert.equal(rows.filter((row) => row.platform === "web").length, 1);
  assert.equal(rows.filter((row) => row.app_id === "au").length, 1);
  assert.deepEqual(
    rows.filter((row) => row.app_id === "cn").map(({ attempt, status }) => [attempt, status]),
    [[1, "failed"], [2, "succeeded"]],
  );
});

test("an unknown external outcome is reconciled by readback before any retry POST", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  let externallyLive = false;
  const calls = [];
  const webAdapter = {
    release: async () => {
      calls.push("release");
      externallyLive = true;
      throw new Error("connection reset after production switch");
    },
    readback: async () => {
      calls.push("readback");
      assert.equal(externallyLive, true);
      return webLiveEvidence();
    },
  };
  const common = {
    db: harness.db,
    manifest: MANIFEST,
    platforms: [{ id: "task-a", platforms: ["web"] }],
    apps: [],
    webAdapter,
    iosAdapter: null,
  };

  const first = await executeProductionRelease({
    ...common,
    lease: releaseLease(),
    now: NOW,
  });
  assert.equal(first.status, "waiting_external");
  assert.deepEqual(calls, ["release"]);

  const second = await executeProductionRelease({
    ...common,
    lease: releaseLease("release-worker-2", LATER),
    now: LATER,
  });
  assert.equal(second.status, "completed");
  assert.deepEqual(calls, ["release", "readback"]);
  assert.deepEqual(
    (await targetRows(harness.db)).results.map(({ attempt, status, reconciliation_status }) => (
      [attempt, status, reconciliation_status]
    )),
    [[1, "running", "unknown_outcome"], [2, "succeeded", "readback_confirmed"]],
  );
});

test("repeated recovery readback failures exhaust the configured safe retry budget", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  let releases = 0;
  let readbacks = 0;
  const common = {
    db: harness.db,
    manifest: MANIFEST,
    platforms: [{ id: "task-a", platforms: ["web"] }],
    apps: [],
    webAdapter: {
      release: async () => {
        releases += 1;
        throw new Error("connection reset after production switch");
      },
      readback: async () => {
        readbacks += 1;
        throw new Error("production readback unavailable");
      },
    },
    iosAdapter: null,
  };

  const first = await executeProductionRelease({
    ...common,
    lease: { ...releaseLease(), maxReconciliationAttempts: 2 },
    now: NOW,
  });
  assert.equal(first.status, "waiting_external");

  const second = await executeProductionRelease({
    ...common,
    lease: { ...releaseLease("release-worker-2", LATER), maxReconciliationAttempts: 2 },
    now: LATER,
  });
  assert.equal(second.status, "failed");
  assert.equal(releases, 1);
  assert.equal(readbacks, 1);
  assert.deepEqual(
    (await targetRows(harness.db)).results.map(({ attempt, status, reconciliation_status }) => (
      [attempt, status, reconciliation_status]
    )),
    [[1, "running", "unknown_outcome"], [2, "failed", "readback_mismatch"]],
  );
});

test("iOS recovery stays before upload while an unknown outcome has no build number", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  let releases = 0;
  let returnWaitingEvidence = false;
  const common = {
    db: harness.db,
    manifest: MANIFEST,
    platforms: [{ id: "task-a", platforms: ["ios"] }],
    apps: [IOS_APPS[0]],
    webAdapter: null,
    iosAdapter: {
      release: async () => {
        releases += 1;
        throw new Error("connection reset before build reservation response");
      },
      readback: async () => {
        if (returnWaitingEvidence) {
          return { status: "waiting_external", observedEvidence: { lookup: "no-build-yet" } };
        }
        throw new Error("App Store Connect readback unavailable");
      },
    },
  };

  assert.equal((await executeProductionRelease({
    ...common,
    lease: releaseLease(),
    now: NOW,
  })).status, "waiting_external");
  assert.equal((await executeProductionRelease({
    ...common,
    lease: releaseLease("release-worker-2", LATER),
    now: LATER,
  })).status, "waiting_external");
  returnWaitingEvidence = true;
  assert.equal((await executeProductionRelease({
    ...common,
    lease: releaseLease("release-worker-3", LATER),
    now: LATER,
  })).status, "waiting_external");
  assert.equal(releases, 1);
  assert.deepEqual(
    (await targetRows(harness.db)).results.map(({ attempt, stage, status, build_number }) => (
      [attempt, stage, status, build_number]
    )),
    [
      [1, "test", "running", null],
      [2, "test", "running", null],
      [3, "test", "running", null],
    ],
  );
});

test("a reclaimed version lease fences the next external effect after an in-flight operation", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const calls = [];
  const result = await executeProductionRelease({
    db: harness.db,
    manifest: MANIFEST,
    platforms: PLATFORMS,
    apps: IOS_APPS,
    webAdapter: {
      release: async () => {
        calls.push("web:release");
        await harness.db.prepare(
          `UPDATE orchestration_leases
           SET holder = 'replacement-worker', fencing_token = fencing_token + 1,
               expires_at = '2026-08-11T09:00:00.000Z'
           WHERE aggregate_type = 'version' AND aggregate_id = ?`,
        ).bind(MANIFEST.versionId).run();
        return webReleaseEvidence();
      },
      readback: async () => calls.push("web:readback"),
    },
    iosAdapter: {
      release: async ({ app }) => calls.push(`${app.id}:release`),
      readback: async ({ app }) => calls.push(`${app.id}:readback`),
    },
    lease: releaseLease(),
    now: NOW,
  });

  assert.equal(result.status, "waiting_external");
  assert.deepEqual(calls, ["web:release"]);
});

test("unsupported task platforms fail closed before persistence or adapter side effects", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const calls = [];

  await assert.rejects(
    executeProductionRelease({
      db: harness.db,
      manifest: MANIFEST,
      platforms: [{ id: "task-a", platforms: ["web", "android"] }],
      apps: [],
      webAdapter: {
        release: async () => calls.push("release"),
        readback: async () => calls.push("readback"),
      },
      iosAdapter: null,
      lease: releaseLease(),
      now: NOW,
    }),
    (error) => error?.code === "UNSUPPORTED_PRODUCTION_PLATFORM",
  );
  assert.deepEqual(calls, []);
  assert.deepEqual((await releaseRows(harness.db)).results, []);
});

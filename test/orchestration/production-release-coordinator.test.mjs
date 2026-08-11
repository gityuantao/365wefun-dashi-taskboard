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
    confirmed: true,
    published: true,
    status: "published",
    authoritative: true,
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
  const submission = {
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
  return {
    ...submission,
    lineage: {
      externalRequestId: submission.externalRequestId,
      buildNumber: submission.buildNumber,
      uploadId: submission.uploadId,
      processingId: submission.processingId,
      reviewSubmissionId: submission.reviewSubmissionId,
    },
  };
}

async function stagedIosSubmission({ app, recordStage, attempt = 1 }) {
  const buildNumber = String(100 + attempt);
  await recordStage("test");
  await recordStage("archive");
  await recordStage("upload", { buildNumber, uploadId: `${app.id}-upload-${attempt}` });
  await recordStage("processing", {
    buildNumber, processingStatus: "processed", processingId: `${app.id}-processing-${attempt}`,
  });
  await recordStage("review_submit", {
    buildNumber, reviewStatus: "submitted", reviewSubmissionId: `${app.id}-submission-${attempt}`,
  });
  await recordStage("review_wait", { buildNumber });
  return iosSubmission(app, attempt);
}

function iosLiveEvidence(app, attempt = 1) {
  const live = {
    status: "completed",
    authoritative: true,
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
    liveEvidence: {
      membershipConfirmed: true,
      appStoreAppId: app.appStoreAppId,
      marketingVersion: app.marketingVersion,
      buildNumber: String(100 + attempt),
      liveId: `${app.id}-live-${attempt}`,
    },
  };
  return {
    ...live,
    lineage: Object.fromEntries([
      "externalRequestId", "buildNumber", "uploadId", "processingId", "reviewSubmissionId",
      "reviewId", "releaseId", "liveId",
    ].map((field) => [field, live[field]])),
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
    release: async ({ manifest, app, recordStage }) => {
      calls.push(`${app.id}:release:${manifest.checksum}:${manifest.candidateCommit}`);
      return stagedIosSubmission({ app, recordStage });
    },
    readback: async ({ manifest, app, recordStage }) => {
      calls.push(`${app.id}:readback:${manifest.checksum}:${manifest.candidateCommit}`);
      await recordStage("live_readback", { buildNumber: "101" });
      if (app.id === "au" && auWaiting) {
        return {
          status: "waiting_external",
          authoritative: true,
          submissionExists: true,
          reviewStatus: "submitted",
          lineage: iosSubmission(app).lineage,
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
    lease: { ...releaseLease(), maxReconciliationAttempts: 4 },
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
    lease: { ...releaseLease("release-worker-2", LATER), maxReconciliationAttempts: 4 },
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
      ["ios", "au", 1, "live_readback", "running"],
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
    release: async ({ app, recordStage }) => {
      releases[app.id] += 1;
      if (app.id === "cn" && rejectCn) {
        const error = new Error("App Store validation rejected the binary");
        error.deterministic = true;
        error.failureClassification = "product_rework";
        throw error;
      }
      return stagedIosSubmission({ app, recordStage, attempt: releases[app.id] });
    },
    readback: async ({ app, recordStage }) => {
      await recordStage("live_readback", { buildNumber: String(100 + releases[app.id]) });
      return iosLiveEvidence(app, releases[app.id]);
    },
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
      release: async ({ recordStage }) => {
        releases += 1;
        await recordStage("test");
        throw new Error("connection reset before build reservation response");
      },
      readback: async ({ recordStage }) => {
        await recordStage("test");
        if (returnWaitingEvidence) {
          return { status: "waiting_external", observedEvidence: { lookup: "no-build-yet" } };
        }
        throw new Error("App Store Connect readback unavailable");
      },
    },
  };

  assert.equal((await executeProductionRelease({
    ...common,
    lease: { ...releaseLease(), maxReconciliationAttempts: 4 },
    now: NOW,
  })).status, "waiting_external");
  assert.equal((await executeProductionRelease({
    ...common,
    lease: { ...releaseLease("release-worker-2", LATER), maxReconciliationAttempts: 4 },
    now: LATER,
  })).status, "waiting_external");
  returnWaitingEvidence = true;
  assert.equal((await executeProductionRelease({
    ...common,
    lease: { ...releaseLease("release-worker-3", LATER), maxReconciliationAttempts: 4 },
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

test("Web terminal success rejects published contradictions", async (t) => {
  for (const contradiction of [
    { published: false, status: "published" },
    { published: true, status: "failed" },
  ]) {
    await t.test(JSON.stringify(contradiction), async (t) => {
      const harness = await createCloudWorkerHarness();
      t.after(() => harness.dispose());
      const result = await executeProductionRelease({
        db: harness.db,
        manifest: MANIFEST,
        platforms: [{ id: "task-a", platforms: ["web"] }],
        apps: [],
        webAdapter: {
          release: async () => webReleaseEvidence(),
          readback: async () => ({ ...webLiveEvidence(), ...contradiction }),
        },
        iosAdapter: null,
        lease: releaseLease(),
        now: NOW,
      });
      assert.equal(result.status, "failed");
    });
  }
});

test("iOS stage evidence persists build identity before upload and follows the legal lifecycle", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const stages = [];
  const record = async (recordStage, stage, evidence) => {
    await recordStage(stage, evidence);
    const latest = (await targetRows(harness.db)).results.at(-1);
    stages.push([latest.stage, latest.build_number]);
  };
  const app = IOS_APPS[0];
  const result = await executeProductionRelease({
    db: harness.db,
    manifest: MANIFEST,
    platforms: [{ id: "task-a", platforms: ["ios"] }],
    apps: [app],
    webAdapter: null,
    iosAdapter: {
      release: async ({ recordStage }) => {
        await record(recordStage, "test", {});
        await record(recordStage, "archive", {});
        await record(recordStage, "upload", { buildNumber: "101", uploadId: "au-upload-1" });
        await record(recordStage, "processing", {
          buildNumber: "101", processingStatus: "processed", processingId: "au-processing-1",
        });
        await record(recordStage, "review_submit", {
          buildNumber: "101", reviewStatus: "submitted", reviewSubmissionId: "au-submission-1",
        });
        await record(recordStage, "review_wait", { buildNumber: "101" });
        return iosSubmission(app);
      },
      readback: async ({ recordStage }) => {
        await record(recordStage, "release", { buildNumber: "101" });
        await record(recordStage, "live_readback", { buildNumber: "101" });
        return iosLiveEvidence(app);
      },
    },
    lease: releaseLease(),
    now: NOW,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.publication.kind, "ios_aggregate");
  assert.equal(result.publication.candidateCommit, CANDIDATE_COMMIT);
  assert.match(result.publication.cleanupToken, /^ios:manifest-checksum-v1:/);
  assert.deepEqual(stages, [
    ["test", null], ["archive", null], ["upload", "101"], ["processing", "101"],
    ["review_submit", "101"], ["review_wait", "101"], ["release", "101"],
    ["live_readback", "101"],
  ]);
});

test("authoritative absence allows one bounded safe repost after unknown outcome", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const calls = [];
  let releaseAttempt = 0;
  let readbackAttempt = 0;
  const common = {
    db: harness.db,
    manifest: MANIFEST,
    platforms: [{ id: "task-a", platforms: ["web"] }],
    apps: [],
    webAdapter: {
      release: async () => {
        calls.push("release");
        releaseAttempt += 1;
        if (releaseAttempt === 1) throw new Error("connection reset");
        return webReleaseEvidence();
      },
      readback: async ({ externalRequestId, idempotencyKey }) => {
        calls.push(`readback:${externalRequestId ?? "none"}:${idempotencyKey}`);
        readbackAttempt += 1;
        return readbackAttempt === 1
          ? { status: "absent", authoritative: true, evidence: { lookup: "not-found" } }
          : webLiveEvidence();
      },
    },
    iosAdapter: null,
  };
  assert.equal((await executeProductionRelease({
    ...common, lease: releaseLease(), now: NOW,
  })).status, "waiting_external");
  assert.equal((await executeProductionRelease({
    ...common, lease: { ...releaseLease("release-worker-2", LATER), maxSafeReposts: 1 }, now: LATER,
  })).status, "completed");
  assert.equal(calls.filter((call) => call === "release").length, 2);
  assert.match(calls[1], /readback:none:version-1:manifest-checksum-v1:web::1/);
});

test("returned unknown readbacks consume the reconciliation budget", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const common = {
    db: harness.db,
    manifest: MANIFEST,
    platforms: [{ id: "task-a", platforms: ["web"] }],
    apps: [],
    webAdapter: {
      release: async () => { throw new Error("connection reset"); },
      readback: async () => ({ status: "unknown", evidence: { lookup: "inconclusive" } }),
    },
    iosAdapter: null,
  };
  assert.equal((await executeProductionRelease({
    ...common, lease: { ...releaseLease(), maxReconciliationAttempts: 2 }, now: NOW,
  })).status, "waiting_external");
  assert.equal((await executeProductionRelease({
    ...common,
    lease: { ...releaseLease("release-worker-2", LATER), maxReconciliationAttempts: 2 },
    now: LATER,
  })).status, "failed");
});

test("post-effect contract gaps recover by locator readback without reposting", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  let releases = 0;
  const readbackArgs = [];
  const common = {
    db: harness.db,
    manifest: MANIFEST,
    platforms: [{ id: "task-a", platforms: ["web"] }],
    apps: [],
    webAdapter: {
      release: async () => {
        releases += 1;
        return {
          artifactIdentity: MANIFEST.artifactIdentity,
          observedEvidence: { locator: "release-by-idempotency" },
        };
      },
      readback: async (options) => {
        readbackArgs.push(options);
        return webLiveEvidence();
      },
    },
    iosAdapter: null,
  };
  assert.equal((await executeProductionRelease({
    ...common, lease: releaseLease(), now: NOW,
  })).status, "waiting_external");
  assert.equal((await executeProductionRelease({
    ...common, lease: releaseLease("release-worker-2", LATER), now: LATER,
  })).status, "completed");
  assert.equal(releases, 1);
  assert.equal(readbackArgs[0].readbackLocator.locator, "release-by-idempotency");
  assert.equal(readbackArgs[0].externalRequestId, null);
  assert.match(readbackArgs[0].idempotencyKey, /:web::1$/);
});

test("iOS terminal readback rejects mixed submission lineage", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const app = IOS_APPS[0];
  const result = await executeProductionRelease({
    db: harness.db,
    manifest: MANIFEST,
    platforms: [{ id: "task-a", platforms: ["ios"] }],
    apps: [app],
    webAdapter: null,
    iosAdapter: {
      release: ({ recordStage }) => stagedIosSubmission({ app, recordStage }),
      readback: async ({ recordStage }) => {
        await recordStage("live_readback", { buildNumber: "101" });
        const observed = iosLiveEvidence(app);
        return {
          ...observed,
          buildNumber: "999",
          liveBuildNumber: "999",
          lineage: { ...observed.lineage, buildNumber: "999" },
        };
      },
    },
    lease: releaseLease(),
    now: NOW,
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /exact frozen Candidate|readback/i);
});

test("iOS terminal and waiting evidence must be authoritative and non-empty", async (t) => {
  const app = IOS_APPS[0];
  for (const [name, mutate] of [
    ["non-authoritative", (observed) => ({ ...observed, authoritative: false })],
    ["empty-live-proof", (observed) => ({
      ...observed, liveMembershipConfirmed: false, liveEvidence: {},
    })],
  ]) {
    await t.test(name, async (t) => {
      const harness = await createCloudWorkerHarness();
      t.after(() => harness.dispose());
      const result = await executeProductionRelease({
        db: harness.db,
        manifest: MANIFEST,
        platforms: [{ id: "task-a", platforms: ["ios"] }],
        apps: [app],
        webAdapter: null,
        iosAdapter: {
          release: ({ recordStage }) => stagedIosSubmission({ app, recordStage }),
          readback: async ({ recordStage }) => {
            await recordStage("live_readback", { buildNumber: "101" });
            return mutate(iosLiveEvidence(app));
          },
        },
        lease: releaseLease(),
        now: NOW,
      });
      assert.equal(result.status, "failed");
    });
  }
});

test("non-authoritative Apple waiting evidence cannot bypass reconciliation exhaustion", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const app = IOS_APPS[0];
  const common = {
    db: harness.db,
    manifest: MANIFEST,
    platforms: [{ id: "task-a", platforms: ["ios"] }],
    apps: [app],
    webAdapter: null,
    iosAdapter: {
      release: ({ recordStage }) => stagedIosSubmission({ app, recordStage }),
      readback: async ({ recordStage }) => {
        await recordStage("live_readback", { buildNumber: "101" });
        return {
          status: "waiting_external",
          authoritative: false,
          submissionExists: true,
          lineage: iosSubmission(app).lineage,
        };
      },
    },
  };
  assert.equal((await executeProductionRelease({
    ...common,
    lease: { ...releaseLease(), maxReconciliationAttempts: 2 },
    now: NOW,
  })).status, "waiting_external");
  assert.equal((await executeProductionRelease({
    ...common,
    lease: { ...releaseLease("release-worker-2", LATER), maxReconciliationAttempts: 2 },
    now: LATER,
  })).status, "failed");
});

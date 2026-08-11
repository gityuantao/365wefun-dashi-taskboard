import assert from "node:assert/strict";
import test from "node:test";

import { createAppStoreReleaseAdapter } from "../../orchestration/ios/app-store-release-adapter.mjs";

const manifest = {
  versionId: "v1.2.3",
  candidateCommit: "1".repeat(40),
  checksum: "manifest-checksum",
};
const app = {
  id: "au",
  scheme: "E365AU",
  testScheme: "E365AU",
  testTarget: "E365StoreKitTests",
  bundleId: "online.365english.app",
  appStoreAppId: "1234567890",
  releaseMode: "automatic",
  reviewConfigurationRef: "ios-review-au",
  marketingVersion: "1.2.3",
};

function runtime() {
  return {
    iosProductionReleaseCommand: ["node", "scripts/release-all-ios-apps.mjs"],
    iosProductionReleaseTimeoutMs: 1200,
    iosProductionCredentialsPath: "/private/asc.private.json",
    repoPath: "/repo/source",
  };
}

test("adapter executes the exact staged production lifecycle with an allowlisted environment", async () => {
  const calls = [];
  const stages = [];
  let fenceChecks = 0;
  const identity = { appId: "au", appStoreAppId: "1234567890", scheme: "E365AU", bundleId: app.bundleId, marketingVersion: "1.2.3", buildNumber: "77" };
  const responses = {
    test: identity,
    archive: identity,
    upload: { ...identity, uploadId: "upload-77", externalRequestId: "upload-request-77" },
    processing: { ...identity, uploadId: "upload-77", externalRequestId: "upload-request-77", processingId: "build-77", processingStatus: "processed" },
    configure_version: { ...identity, uploadId: "upload-77", externalRequestId: "upload-request-77", processingId: "build-77", processingStatus: "processed", automaticRelease: true },
    configure_review: { ...identity, uploadId: "upload-77", externalRequestId: "upload-request-77", processingId: "build-77", processingStatus: "processed", automaticRelease: true, reviewConfigurationApplied: true },
    ensure_review: { ...identity, uploadId: "upload-77", externalRequestId: "upload-request-77", processingId: "build-77", processingStatus: "processed", reviewSubmissionId: "submission-77", automaticRelease: true },
    ensure_review_item: { ...identity, uploadId: "upload-77", externalRequestId: "upload-request-77", processingId: "build-77", processingStatus: "processed", reviewSubmissionId: "submission-77", automaticRelease: true },
    submit_review: { appId: "au", appStoreAppId: "1234567890", bundleId: app.bundleId, marketingVersion: "1.2.3", buildNumber: "77", uploadId: "upload-77", processingId: "build-77", reviewSubmissionId: "submission-77", reviewStatus: "submitted", automaticRelease: true, externalRequestId: "upload-request-77" },
    read_review: { appId: "au", appStoreAppId: "1234567890", bundleId: app.bundleId, marketingVersion: "1.2.3", buildNumber: "77", uploadId: "upload-77", processingId: "build-77", reviewSubmissionId: "submission-77", reviewStatus: "waiting_for_review", automaticRelease: true, externalRequestId: "upload-request-77", authoritative: true, submissionExists: true },
  };
  const adapter = createAppStoreReleaseAdapter({
    runtime: runtime(), projectRoot: "/project",
    runCommand: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: `progress\n${JSON.stringify(responses[options.env.IOS_PRODUCTION_MODE])}\n` };
    },
  });

  const submission = await adapter.release({
    manifest, app, idempotencyKey: "idem-77",
    recordStage: async (stage, evidence) => stages.push([stage, evidence]),
    beforeExternalOperation: async () => { fenceChecks += 1; },
    afterExternalOperation: async () => { fenceChecks += 1; },
  });
  assert.deepEqual(stages.map(([stage]) => stage).filter((stage, index, all) => index === 0 || all[index - 1] !== stage), ["test", "archive", "upload", "processing", "review_submit", "review_wait"]);
  assert.equal(submission.lineage.reviewSubmissionId, "submission-77");
  assert.deepEqual(calls.map((call) => call.options.env.IOS_PRODUCTION_MODE), ["test", "archive", "upload", "processing", "configure_version", "configure_review", "ensure_review", "ensure_review_item", "submit_review", "read_review"]);
  assert.equal(fenceChecks, calls.length * 2);
  for (const call of calls) {
    assert.equal(call.file, "node");
    assert.deepEqual(call.args, ["scripts/release-all-ios-apps.mjs"]);
    assert.equal(call.options.cwd, "/project");
    assert.equal(call.options.timeout, 1200);
    assert.equal(call.options.env.IOS_APP_ID, "au");
    assert.equal(call.options.env.IOS_APP_STORE_APP_ID, "1234567890");
    assert.equal(call.options.env.IOS_SCHEME, "E365AU");
    assert.equal(call.options.env.IOS_BUNDLE_ID, app.bundleId);
    assert.equal(call.options.env.IOS_MARKETING_VERSION, "1.2.3");
    assert.equal(call.options.env.IOS_RELEASE_MODE, "automatic");
    assert.equal(call.options.env.IOS_REVIEW_CONFIGURATION_REF, "ios-review-au");
    assert.equal(call.options.env.IOS_PRODUCTION_CREDENTIALS_PATH, "/private/asc.private.json");
    assert.equal(call.options.env.PARENT_SECRET, undefined);
  }
});

test("authoritative review waiting is read-only and never repeats upload or submission", async () => {
  const modes = [];
  const lineage = {
    externalRequestId: "upload-request-77", buildNumber: "77", uploadId: "upload-77",
    processingId: "build-77", reviewSubmissionId: "submission-77",
  };
  const adapter = createAppStoreReleaseAdapter({
    runtime: runtime(), projectRoot: "/project",
    runCommand: async (_file, _args, options) => {
      modes.push(options.env.IOS_PRODUCTION_MODE);
      return { stdout: JSON.stringify({
        ...lineage, appId: "au", appStoreAppId: app.appStoreAppId, bundleId: app.bundleId,
        marketingVersion: app.marketingVersion, reviewStatus: "in_review", automaticRelease: true,
        authoritative: true, submissionExists: true,
      }) };
    },
  });
  const stages = [];
  const observed = await adapter.readback({
    manifest, app, submission: { ...lineage, lineage },
    recordStage: async (stage) => stages.push(stage),
  });
  assert.equal(observed.status, "waiting_external");
  assert.deepEqual(modes, ["read_review"]);
  assert.deepEqual(stages, ["review_wait"]);
});

test("unknown review POST recovers by exact build identity without a persisted submission ID", async () => {
  const modes = [];
  const adapter = createAppStoreReleaseAdapter({
    runtime: runtime(), projectRoot: "/project",
    runCommand: async (_file, _args, options) => {
      modes.push(options.env.IOS_PRODUCTION_MODE);
      assert.equal(options.env.IOS_REVIEW_SUBMISSION_ID, "");
      return { stdout: JSON.stringify({
        appId: "au", appStoreAppId: app.appStoreAppId, bundleId: app.bundleId,
        marketingVersion: app.marketingVersion, buildNumber: "77", uploadId: "upload-77",
        externalRequestId: "request-77", processingId: "build-77",
        reviewSubmissionId: "submission-reconciled", reviewStatus: "in_review",
        automaticRelease: true, authoritative: true, submissionExists: true,
      }) };
    },
  });
  const observed = await adapter.readback({ manifest, app, submission: {
    externalRequestId: "request-77", buildNumber: "77", uploadId: "upload-77", processingId: "build-77",
  }, recordStage: async () => {} });
  assert.equal(observed.status, "waiting_external");
  assert.equal(observed.lineage.reviewSubmissionId, "submission-reconciled");
  assert.deepEqual(modes, ["read_review"]);
});

test("approved automatic release requires exact authoritative live build lineage", async () => {
  const modes = [];
  const lineage = {
    externalRequestId: "upload-request-77", buildNumber: "77", uploadId: "upload-77",
    processingId: "build-77", reviewSubmissionId: "submission-77",
  };
  const adapter = createAppStoreReleaseAdapter({
    runtime: runtime(), projectRoot: "/project",
    runCommand: async (_file, _args, options) => {
      modes.push(options.env.IOS_PRODUCTION_MODE);
      if (options.env.IOS_PRODUCTION_MODE === "read_review") return { stdout: JSON.stringify({
        ...lineage, appId: "au", appStoreAppId: app.appStoreAppId, bundleId: app.bundleId,
        marketingVersion: app.marketingVersion, reviewStatus: "approved", reviewId: "review-77",
        releaseStatus: "released", releaseId: "release-77", automaticRelease: true,
        authoritative: true, submissionExists: true,
      }) };
      return { stdout: JSON.stringify({
        ...lineage, appId: "au", appStoreAppId: app.appStoreAppId, bundleId: app.bundleId,
        marketingVersion: app.marketingVersion, reviewStatus: "approved", reviewId: "review-77",
        releaseStatus: "released", releaseId: "release-77", liveStatus: "live", liveId: "live-77",
        liveMarketingVersion: "1.2.3", liveBuildNumber: "77", automaticRelease: true,
        authoritative: true, liveMembershipConfirmed: true,
      }) };
    },
  });
  const stages = [];
  const observed = await adapter.readback({
    manifest, app, submission: { ...lineage, lineage },
    recordStage: async (stage) => stages.push(stage),
  });
  assert.equal(observed.status, "completed");
  assert.equal(observed.liveId, "live-77");
  assert.deepEqual(observed.lineage, { ...lineage, reviewId: "review-77", releaseId: "release-77", liveId: "live-77" });
  assert.deepEqual(modes, ["read_review", "read_live"]);
  assert.deepEqual(stages, ["review_wait", "release", "live_readback"]);
});

test("approved review waits while the exact automatic release propagates to the store", async () => {
  const lineage = { externalRequestId: "request-77", buildNumber: "77", uploadId: "upload-77", processingId: "build-77", reviewSubmissionId: "submission-77" };
  const adapter = createAppStoreReleaseAdapter({ runtime: runtime(), projectRoot: "/project", runCommand: async (_file, _args, options) => ({ stdout: JSON.stringify(options.env.IOS_PRODUCTION_MODE === "read_review" ? {
    ...lineage, appId: "au", appStoreAppId: app.appStoreAppId, bundleId: app.bundleId, marketingVersion: app.marketingVersion,
    reviewStatus: "approved", reviewId: "review-77", releaseStatus: "waiting", automaticRelease: true, authoritative: true, submissionExists: true,
  } : {
    ...lineage, appId: "au", appStoreAppId: app.appStoreAppId, bundleId: app.bundleId, marketingVersion: app.marketingVersion,
    reviewStatus: "approved", reviewId: "review-77", releaseStatus: "waiting", releaseId: "release-77", liveStatus: "waiting", liveId: "live-77",
    liveMarketingVersion: "1.2.3", liveBuildNumber: "77", automaticRelease: true, authoritative: true, liveMembershipConfirmed: false,
  }) }) });
  const result = await adapter.readback({ manifest, app, submission: { ...lineage, lineage }, recordStage: async () => {} });
  assert.equal(result.status, "waiting_external");
  assert.equal(result.authoritative, true);
});

test("adapter types rejection and redacts command failures", async () => {
  const rejected = createAppStoreReleaseAdapter({
    runtime: runtime(), projectRoot: "/project",
    runCommand: async () => ({ stdout: JSON.stringify({
      appId: "au", appStoreAppId: app.appStoreAppId, bundleId: app.bundleId,
      marketingVersion: app.marketingVersion, buildNumber: "77", uploadId: "upload-77",
      processingId: "build-77", reviewSubmissionId: "submission-77", reviewStatus: "rejected",
      automaticRelease: true, authoritative: true, submissionExists: true,
    }) }),
  });
  await assert.rejects(rejected.readback({ manifest, app, submission: {
    externalRequestId: "request-77", buildNumber: "77", uploadId: "upload-77", processingId: "build-77", reviewSubmissionId: "submission-77",
  }, recordStage: async () => {} }), (error) => error.deterministic === true && error.failureClassification === "product_rework");

  const failed = createAppStoreReleaseAdapter({
    runtime: runtime(), projectRoot: "/project",
    runCommand: async () => { throw new Error("Authorization: Bearer abc.def.ghi password=hunter2"); },
  });
  await assert.rejects(failed.release({ manifest, app, idempotencyKey: "idem", recordStage: async () => {} }), (error) => {
    assert.doesNotMatch(error.message, /abc\.def|hunter2/);
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
});

test("script typed validation evidence remains deterministic across the process boundary", async () => {
  const adapter = createAppStoreReleaseAdapter({ runtime: runtime(), projectRoot: "/project", runCommand: async () => ({ stdout: JSON.stringify({ ok: false, error: { deterministic: true, classification: "validation", message: "iOS production validation failed" } }) }) });
  await assert.rejects(adapter.release({ manifest, app, idempotencyKey: "idem", recordStage: async () => {} }), (error) => error.deterministic === true && error.failureClassification === "validation");
});

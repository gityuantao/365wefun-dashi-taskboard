import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProductionArchiveCommand,
  buildProductionTestCommand,
  buildReviewSubmissionRequest,
  confirmsExactLiveBuild,
  releaseAllIosApps,
  resolveReviewConfiguration,
  waitForProcessedBuild,
  validateProductionEnvironment,
} from "../../scripts/release-all-ios-apps.mjs";

const baseApp = {
  id: "au", enabled: true, scheme: "E365AU", testScheme: "E365AU",
  testTarget: "E365StoreKitTests", bundleId: "online.365english.app",
  appStoreAppId: "1234567890", releaseMode: "automatic", reviewConfigurationRef: "review-au",
};

test("production build uses Release, exact identity, automated tests, and no staging/debug fixtures", () => {
  const context = { app: baseApp, projectPath: "/candidate/apps/ios/E365.xcodeproj", iosDirectory: "/candidate/apps/ios", archivePath: "/artifacts/au/E365AU.xcarchive", derivedDataPath: "/artifacts/au/DerivedData", marketingVersion: "1.2.3", buildNumber: "77", productionApiUrl: "https://api.example.com", testDestination: "platform=iOS Simulator,name=iPhone 17 Pro" };
  const testCommand = buildProductionTestCommand(context);
  const archive = buildProductionArchiveCommand(context);
  assert.equal(testCommand.args.includes("-only-testing:E365StoreKitTests"), true);
  assert.equal(archive.args.includes("Release"), true);
  for (const exact of ["MARKETING_VERSION=1.2.3", "CURRENT_PROJECT_VERSION=77", "PRODUCT_BUNDLE_IDENTIFIER=online.365english.app", "API_BASE_URL=https://api.example.com"]) assert.equal(archive.args.includes(exact), true);
  const all = JSON.stringify([testCommand, archive]);
  assert.doesNotMatch(all, /Staging|E365_UI_TEST_IAP_MODE|QuickLessonUITestIAPAPI|\.storekit/);
});

test("review request binds the exact App and automatic release is configured on the exact version", () => {
  assert.deepEqual(buildReviewSubmissionRequest({ app: baseApp, buildId: "build-77", versionId: "version-123" }), {
    path: "/v1/reviewSubmissions",
    method: "POST",
    body: { data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: "1234567890" } } } } },
    versionRequest: { path: "/v1/appStoreVersions/version-123", method: "PATCH", body: { data: { type: "appStoreVersions", id: "version-123", attributes: { releaseType: "AFTER_APPROVAL" }, relationships: { build: { data: { type: "builds", id: "build-77" } } } } } },
  });
});

test("all enabled Apps execute in registry order and a future third App needs no country branch", async () => {
  const apps = [baseApp, { ...baseApp, id: "cn", scheme: "E365CN", bundleId: "online.365english.china", appStoreAppId: "2234567890" }, { ...baseApp, id: "jp", scheme: "E365JP", bundleId: "online.365english.jp", appStoreAppId: "3234567890" }, { ...baseApp, id: "disabled", enabled: false }];
  const calls = [];
  const result = await releaseAllIosApps({ apps, executeApp: async (app) => { calls.push(app.id); return app.appStoreAppId; } });
  assert.deepEqual(calls, ["au", "cn", "jp"]);
  assert.deepEqual(result, ["1234567890", "2234567890", "3234567890"]);
});

test("processing performs authoritative GET polling until the exact build is valid", async () => {
  const states = [null, { id: "build-77", attributes: { processingState: "PROCESSING", version: "77" } }, { id: "build-77", attributes: { processingState: "VALID", version: "77" } }];
  let sleeps = 0;
  const build = await waitForProcessedBuild({
    client: { findExactBuild: async () => states.shift() }, appResourceId: "1234567890",
    marketingVersion: "1.2.3", buildNumber: "77", maxAttempts: 4,
    sleep: async () => { sleeps += 1; },
  });
  assert.equal(build.id, "build-77");
  assert.equal(sleeps, 2);
});

test("processing can return authoritative absence after bounded exact-build GETs", async () => {
  const build = await waitForProcessedBuild({
    client: { findExactBuild: async () => null }, appResourceId: "1234567890",
    marketingVersion: "1.2.3", buildNumber: "77", maxAttempts: 2,
    sleep: async () => {}, returnAuthoritativeAbsence: true,
  });
  assert.equal(build, null);
});

test("an observed exact build that remains processing never becomes authoritative absence", async () => {
  await assert.rejects(waitForProcessedBuild({
    client: { findExactBuild: async () => ({ id: "build-77", attributes: { processingState: "PROCESSING", version: "77" } }) },
    appResourceId: "1234567890", marketingVersion: "1.2.3", buildNumber: "77",
    maxAttempts: 2, sleep: async () => {}, returnAuthoritativeAbsence: true,
  }), /did not complete/);
});

test("live proof requires the App Store version build relationship to match the processed build", () => {
  const exactBuild = { id: "build-77", attributes: { version: "77" } };
  assert.equal(confirmsExactLiveBuild({ versionState: "READY_FOR_SALE", exactBuild, relatedBuild: exactBuild, processingId: "build-77" }), true);
  assert.equal(confirmsExactLiveBuild({ versionState: "READY_FOR_SALE", exactBuild, relatedBuild: { id: "build-76", attributes: { version: "76" } }, processingId: "build-77" }), false);
  assert.equal(confirmsExactLiveBuild({ versionState: "PROCESSING_FOR_DISTRIBUTION", exactBuild, relatedBuild: exactBuild, processingId: "build-77" }), false);
});

test("environment requires production identity and a private credential path", () => {
  const config = validateProductionEnvironment({
    IOS_PRODUCTION_MODE: "read_review", IOS_APP_ID: "au", IOS_SCHEME: "E365AU",
    IOS_TEST_SCHEME: "E365AU", IOS_TEST_TARGET: "E365StoreKitTests",
    IOS_BUNDLE_ID: "online.365english.app", IOS_APP_STORE_APP_ID: "1234567890",
    IOS_MARKETING_VERSION: "1.2.3", IOS_BUILD_NUMBER: "77", IOS_UPLOAD_ID: "upload-77",
    IOS_PROCESSING_ID: "build-77", IOS_REVIEW_SUBMISSION_ID: "submission-77",
    IOS_RELEASE_MODE: "automatic", IOS_REVIEW_CONFIGURATION_REF: "review-au",
    IOS_PRODUCTION_CREDENTIALS_PATH: "/private/asc.private.json",
    IOS_PRODUCTION_API_URL: "https://api.example.com",
    IOS_PRODUCTION_REPO_PATH: "/repo/source",
    IOS_PRODUCTION_IDEMPOTENCY_KEY: "idem-77",
    PRODUCTION_CANDIDATE_COMMIT: "1".repeat(40),
    PRODUCTION_VERSION_ID: "v1.2.3",
    PRODUCTION_MANIFEST_CHECKSUM: "manifest-checksum",
  }, { checkFilesystem: false });
  assert.equal(config.app.appStoreAppId, "1234567890");
  assert.equal(config.app.releaseMode, "automatic");
  assert.throws(() => validateProductionEnvironment({ ...process.env, IOS_PRODUCTION_MODE: "read_review" }, { checkFilesystem: false }), /IOS_APP_ID/);
});

test("review configuration refs resolve only allowlisted private review-detail fields", () => {
  assert.deepEqual(resolveReviewConfiguration({ "app-store-review/au": { reviewDetailAttributes: { contactEmail: "release@example.com", demoAccountRequired: false, notes: "Automated release" } } }, "app-store-review/au"), { reviewDetailAttributes: { contactEmail: "release@example.com", demoAccountRequired: false, notes: "Automated release" } });
  assert.throws(() => resolveReviewConfiguration({ "app-store-review/au": { reviewDetailAttributes: { unknownSecret: "x" } } }, "app-store-review/au"), /unsupported/);
  assert.throws(() => resolveReviewConfiguration({}, "app-store-review/au"), /reference is missing/);
});

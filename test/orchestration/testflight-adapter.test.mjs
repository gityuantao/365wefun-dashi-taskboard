import assert from "node:assert/strict";
import test from "node:test";

import { createTestFlightAdapter } from "../../orchestration/ios/testflight-adapter.mjs";

const PROJECT_ROOT = process.cwd();
const APP = {
  id: "au",
  scheme: "E365AU",
  bundleId: "online.365english.app",
  testFlightGroup: "Internal Testing",
};
const CANDIDATE_COMMIT = "1111111111111111111111111111111111111111";
const TARGET_VERSION = "1.2.3";

function nodeCommand(source) {
  return [process.execPath, "-e", source];
}

function createRuntime({ stageSource, readbackSource }) {
  return {
    repoPath: "/repos/365wefun",
    iosTestFlightTimeoutMs: 12_345,
    iosTestFlightStageCommand: nodeCommand(stageSource),
    iosTestFlightReadbackCommand: nodeCommand(readbackSource),
  };
}

function requiredEnvironmentGuard(expected) {
  return [
    `const expected = ${JSON.stringify(expected)};`,
    "for (const [name, value] of Object.entries(expected)) {",
    "  if (process.env[name] !== value) {",
    "    console.error(`${name} was ${JSON.stringify(process.env[name])}, expected ${JSON.stringify(value)}`);",
    "    process.exit(1);",
    "  }",
    "}",
  ].join("\n");
}

test("stage passes the frozen Candidate and App identity through command environment and reads only final JSON evidence", async () => {
  const stageSource = [
    requiredEnvironmentGuard({
      IOS_APP_ID: "au",
      IOS_SCHEME: "E365AU",
      IOS_BUNDLE_ID: "online.365english.app",
      IOS_MARKETING_VERSION: TARGET_VERSION,
      IOS_TESTFLIGHT_GROUP: "Internal Testing",
      STAGING_CANDIDATE_COMMIT: CANDIDATE_COMMIT,
      STAGING_REPO_PATH: "/repos/365wefun",
    }),
    "console.log(JSON.stringify({ buildNumber: 'wrong-build', uploadId: 'wrong-upload' }));",
    "console.log(JSON.stringify({",
    "  appId: process.env.IOS_APP_ID,",
    "  scheme: process.env.IOS_SCHEME,",
    "  bundleId: process.env.IOS_BUNDLE_ID,",
    "  marketingVersion: process.env.IOS_MARKETING_VERSION,",
    "  buildNumber: '42',",
    "  uploadId: 'upload-42'",
    "}));",
  ].join("\n");
  const adapter = createTestFlightAdapter({
    runtime: createRuntime({ stageSource, readbackSource: "process.exit(0);" }),
    projectRoot: PROJECT_ROOT,
  });

  const staged = await adapter.stage({
    candidateCommit: CANDIDATE_COMMIT,
    targetVersion: TARGET_VERSION,
    app: APP,
  });

  assert.deepEqual(staged, {
    appId: "au",
    scheme: "E365AU",
    bundleId: "online.365english.app",
    marketingVersion: "1.2.3",
    buildNumber: "42",
    uploadId: "upload-42",
  });
});

test("stage rejects JSON evidence missing an App Store Connect upload identity", async () => {
  const adapter = createTestFlightAdapter({
    runtime: createRuntime({
      stageSource: "console.log(JSON.stringify({ appId: 'au', scheme: 'E365AU', bundleId: 'online.365english.app', marketingVersion: '1.2.3', buildNumber: '42' }));",
      readbackSource: "process.exit(0);",
    }),
    projectRoot: PROJECT_ROOT,
  });

  await assert.rejects(
    adapter.stage({ candidateCommit: CANDIDATE_COMMIT, targetVersion: TARGET_VERSION, app: APP }),
    /stage evidence.*uploadId/i,
  );
});

test("readback accepts only matching processed Internal Testing evidence", async () => {
  const readbackSource = [
    "console.log(JSON.stringify({",
    "  bundleId: process.env.IOS_BUNDLE_ID,",
    "  marketingVersion: process.env.IOS_MARKETING_VERSION,",
    "  buildNumber: process.env.IOS_BUILD_NUMBER,",
    "  testGroup: process.env.IOS_TESTFLIGHT_GROUP,",
    "  processed: true,",
    "  processingStatus: 'processed',",
    "  membershipConfirmed: true,",
    "  checkedAt: '2026-08-10T00:00:00.000Z'",
    "}));",
  ].join("\n");
  const adapter = createTestFlightAdapter({
    runtime: createRuntime({ stageSource: "process.exit(0);", readbackSource }),
    projectRoot: PROJECT_ROOT,
  });

  const observed = await adapter.readback({
    app: APP,
    staged: {
      appId: "au",
      scheme: "E365AU",
      bundleId: "online.365english.app",
      marketingVersion: "1.2.3",
      buildNumber: "42",
      uploadId: "upload-42",
    },
  });

  assert.deepEqual(observed, {
    processed: true,
    processingStatus: "processed",
    testGroup: "Internal Testing",
    membershipConfirmed: true,
    checkedAt: "2026-08-10T00:00:00.000Z",
  });
});

for (const [field, value] of [
  ["bundleId", "online.365english.other"],
  ["marketingVersion", "9.9.9"],
  ["buildNumber", "99"],
  ["testGroup", "External Testing"],
  ["processed", false],
  ["processingStatus", "processing"],
  ["membershipConfirmed", false],
]) {
  test(`readback fails closed when ${field} is not the exact confirmed value`, async () => {
    const evidence = {
      bundleId: "online.365english.app",
      marketingVersion: "1.2.3",
      buildNumber: "42",
      testGroup: "Internal Testing",
      processed: true,
      processingStatus: "processed",
      membershipConfirmed: true,
      checkedAt: "2026-08-10T00:00:00.000Z",
      [field]: value,
    };
    const adapter = createTestFlightAdapter({
      runtime: createRuntime({
        stageSource: "process.exit(0);",
        readbackSource: `console.log(${JSON.stringify(JSON.stringify(evidence))});`,
      }),
      projectRoot: PROJECT_ROOT,
    });

    await assert.rejects(
      adapter.readback({
        app: APP,
        staged: {
          appId: "au",
          scheme: "E365AU",
          bundleId: "online.365english.app",
          marketingVersion: "1.2.3",
          buildNumber: "42",
          uploadId: "upload-42",
        },
      }),
      /readback evidence/i,
    );
  });
}

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTestFlightAdapter } from "../../orchestration/ios/testflight-adapter.mjs";

const PROJECT_ROOT = process.cwd();
const APP = {
  id: "au",
  scheme: "E365AU",
  testScheme: "E365AU",
  testTarget: "E365StoreKitTests",
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

test("stage normalizes a ClickUp v-prefixed version and passes the frozen Candidate and App identity", async () => {
  const stageSource = [
    requiredEnvironmentGuard({
      IOS_APP_ID: "au",
      IOS_SCHEME: "E365AU",
      IOS_TEST_SCHEME: "E365AU",
      IOS_TEST_TARGET: "E365StoreKitTests",
      IOS_BUNDLE_ID: "online.365english.app",
      IOS_MARKETING_VERSION: TARGET_VERSION,
      IOS_TESTFLIGHT_GROUP: "Internal Testing",
      IOS_TESTFLIGHT_ADAPTER_TIMEOUT_MS: "12345",
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
    targetVersion: `v${TARGET_VERSION}`,
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

test("adapter readback reaches the real script without a Candidate-only preflight", async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ios-real-readback-contract-"));
  const keyId = "CONTRACT01";
  const keyPath = path.join(temporaryRoot, `AuthKey_${keyId}.p8`);
  const hookPath = path.join(temporaryRoot, "fake-asc-fetch.mjs");
  const scriptPath = path.resolve("scripts/stage-all-ios-apps.mjs");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(hookPath, `
globalThis.fetch = async (input) => {
  const url = new URL(input);
  let body;
  if (url.pathname === "/v1/apps") {
    body = { data: [{ id: "app-resource-id", attributes: { bundleId: "online.365english.app" } }] };
  } else if (url.pathname === "/v1/builds") {
    body = { data: [{ id: "build-resource-id", attributes: { version: "42", processingState: "VALID" } }] };
  } else if (url.pathname === "/v1/betaGroups") {
    body = { data: [{ id: "group-resource-id", attributes: { name: "Internal Testing", isInternalGroup: true } }] };
  } else if (url.pathname === "/v1/betaGroups/group-resource-id/builds") {
    body = { data: [{ id: "build-resource-id", attributes: { version: "42", processingState: "VALID" } }] };
  } else {
    return new Response("not found", { status: 404 });
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
};
`);
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const previous = new Map();
  for (const [name, value] of Object.entries({
    ASC_KEY_ID: keyId,
    ASC_ISSUER_ID: "11111111-2222-3333-4444-555555555555",
    ASC_PRIVATE_KEY_PATH: keyPath,
    IOS_STAGING_DRY_RUN: undefined,
    STAGING_CANDIDATE_COMMIT: undefined,
  })) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const adapter = createTestFlightAdapter({
    runtime: {
      repoPath: "/path/readback/must/not/inspect",
      iosTestFlightTimeoutMs: 5_000,
      iosTestFlightStageCommand: [process.execPath, scriptPath, "stage"],
      iosTestFlightReadbackCommand: [process.execPath, "--import", hookPath, scriptPath, "readback"],
    },
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
    checkedAt: observed.checkedAt,
  });
  assert.match(observed.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("readback mismatch exposes only a sanitized observed status snapshot", async () => {
  const evidence = {
    bundleId: "online.365english.app",
    marketingVersion: "1.2.3",
    buildNumber: "42",
    testGroup: [
      "https://alice:url-password@example.com/groups",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhc2Mtc2VjcmV0In0.signaturevalue123",
    ].join(" "),
    processed: false,
    processingStatus: "Set-Cookie: asc_session=cookie-secret; Path=/",
    membershipConfirmed: false,
    checkedAt: "2026-08-10T00:00:00.000Z",
    token: "top-level-secret",
    rawBody: "raw-body-secret",
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
    (error) => {
      assert.equal(error.name, "TestFlightReadbackError");
      assert.equal(error.stage, "internal_testing");
      assert.deepEqual(error.observed, {
        processed: false,
        processingStatus: "Set-Cookie: [REDACTED]",
        testGroup: "https://[REDACTED]@example.com/groups [REDACTED]",
        membershipConfirmed: false,
      });
      assert.doesNotMatch(
        JSON.stringify(error.observed),
        /url-password|cookie-secret|asc-secret|top-level-secret|raw-body-secret|rawBody/,
      );
      return true;
    },
  );

  for (const unsafeGroup of [
    "https://secret-token@example.com/groups",
    "https://:url-password@example.com/groups",
    "https://alice:first-secret@second-secret@example.com/groups",
  ]) {
    const boundaryAdapter = createTestFlightAdapter({
      runtime: createRuntime({
        stageSource: "process.exit(0);",
        readbackSource: `console.log(${JSON.stringify(JSON.stringify({
          ...evidence,
          testGroup: unsafeGroup,
          processingStatus: "processing",
        }))});`,
      }),
      projectRoot: PROJECT_ROOT,
    });
    await assert.rejects(
      boundaryAdapter.readback({
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
      (error) => {
        assert.equal(error.observed.testGroup, "https://[REDACTED]@example.com/groups");
        assert.doesNotMatch(error.observed.testGroup, /secret-token|url-password/);
        return true;
      },
    );
  }
});

for (const [field, value, stage] of [
  ["bundleId", "online.365english.other", "processing"],
  ["marketingVersion", "9.9.9", "processing"],
  ["buildNumber", "99", "processing"],
  ["testGroup", "External Testing", "internal_testing"],
  ["processed", false, "processing"],
  ["processingStatus", "processing", "processing"],
  ["membershipConfirmed", false, "internal_testing"],
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
      (error) => {
        assert.match(error.message, /readback evidence/i);
        assert.equal(error.stage, stage);
        return true;
      },
    );
  });
}

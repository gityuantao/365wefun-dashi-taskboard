import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  STAGING_API_URL,
  assertDebugHooksAbsent,
  buildArchiveCommand,
  buildBuildSettingsCommand,
  buildExactBuildQuery,
  buildExportCommand,
  buildGroupMembershipRequest,
  buildGroupQuery,
  buildTestCommand,
  buildUploadCommand,
  createBuildPaths,
  ensureProcessedAndInGroup,
  extractUploadIdentifier,
  nextBuildNumberFromBuilds,
  redactCommand,
  validateEnvironment,
  verifyArtifactIdentity,
  withCandidateWorktree,
} from "../../scripts/stage-all-ios-apps.mjs";

const SCRIPT_PATH = path.resolve("scripts/stage-all-ios-apps.mjs");
const CANDIDATE_COMMIT = "1111111111111111111111111111111111111111";

const APPS = {
  au: {
    id: "au",
    scheme: "E365AU",
    bundleId: "online.365english.app",
    otherBundleId: "online.365english.china",
  },
  cn: {
    id: "cn",
    scheme: "E365CN",
    bundleId: "online.365english.china",
    otherBundleId: "online.365english.app",
  },
};

function commandContext(app) {
  const paths = createBuildPaths({
    candidatePath: "/private/tmp/ios-candidate",
    artifactsRoot: "/private/tmp/ios-artifacts",
    app,
  });
  return {
    app,
    paths,
    marketingVersion: "1.2.3",
    buildNumber: "2046",
    testDestination: "platform=iOS Simulator,name=iPhone 17 Pro",
    apiUrl: STAGING_API_URL,
  };
}

for (const app of Object.values(APPS)) {
  test(`${app.scheme} commands select only that App and use release-optimized Staging`, () => {
    const context = commandContext(app);
    const settings = buildBuildSettingsCommand(context);
    const testCommand = buildTestCommand(context);
    const archive = buildArchiveCommand(context);

    assert.deepEqual(settings, {
      file: "xcodebuild",
      args: [
        "-project", "/private/tmp/ios-candidate/apps/ios/E365.xcodeproj",
        "-target", app.scheme,
        "-configuration", "Staging",
        "-showBuildSettings",
        `MARKETING_VERSION=1.2.3`,
        `CURRENT_PROJECT_VERSION=2046`,
        `PRODUCT_BUNDLE_IDENTIFIER=${app.bundleId}`,
        `API_BASE_URL=https://test-api.365english.online`,
      ],
      cwd: "/private/tmp/ios-candidate/apps/ios",
    });
    assert.deepEqual(testCommand.args, [
      "test",
      "-project", "/private/tmp/ios-candidate/apps/ios/E365.xcodeproj",
      "-scheme", app.scheme,
      "-configuration", "Staging",
      "-destination", "platform=iOS Simulator,name=iPhone 17 Pro",
      "-derivedDataPath", `/private/tmp/ios-artifacts/${app.id}/DerivedData`,
      "API_BASE_URL=https://test-api.365english.online",
    ]);
    assert.deepEqual(archive.args, [
      "archive",
      "-project", "/private/tmp/ios-candidate/apps/ios/E365.xcodeproj",
      "-scheme", app.scheme,
      "-configuration", "Staging",
      "-destination", "generic/platform=iOS",
      "-archivePath", `/private/tmp/ios-artifacts/${app.id}/${app.scheme}.xcarchive`,
      "-derivedDataPath", `/private/tmp/ios-artifacts/${app.id}/DerivedData`,
      "-allowProvisioningUpdates",
      "MARKETING_VERSION=1.2.3",
      "CURRENT_PROJECT_VERSION=2046",
      `PRODUCT_BUNDLE_IDENTIFIER=${app.bundleId}`,
      "API_BASE_URL=https://test-api.365english.online",
    ]);

    const allArguments = [settings, testCommand, archive].flatMap((command) => command.args);
    assert.equal(allArguments.includes(app.otherBundleId), false);
    assert.equal(allArguments.includes("-configuration=Debug"), false);
    assert.equal(allArguments.includes("DEBUG"), false);
  });
}

test("per-App paths isolate DerivedData, archive, export, and IPA expansion", () => {
  const au = commandContext(APPS.au).paths;
  const cn = commandContext(APPS.cn).paths;

  assert.deepEqual(au, {
    iosDirectory: "/private/tmp/ios-candidate/apps/ios",
    projectPath: "/private/tmp/ios-candidate/apps/ios/E365.xcodeproj",
    appRoot: "/private/tmp/ios-artifacts/au",
    derivedDataPath: "/private/tmp/ios-artifacts/au/DerivedData",
    archivePath: "/private/tmp/ios-artifacts/au/E365AU.xcarchive",
    exportPath: "/private/tmp/ios-artifacts/au/export",
    exportOptionsPath: "/private/tmp/ios-artifacts/au/ExportOptions.plist",
    ipaExpansionPath: "/private/tmp/ios-artifacts/au/ipa-expanded",
  });
  assert.equal(Object.values(au).some((value) => Object.values(cn).includes(value)), true);
  for (const field of [
    "appRoot",
    "derivedDataPath",
    "archivePath",
    "exportPath",
    "exportOptionsPath",
    "ipaExpansionPath",
  ]) {
    assert.notEqual(au[field], cn[field]);
  }
});

test("export uses App Store Connect options and upload credentials are redacted", () => {
  const context = commandContext(APPS.au);
  const exportCommand = buildExportCommand(context);
  assert.deepEqual(exportCommand, {
    file: "xcodebuild",
    args: [
      "-exportArchive",
      "-archivePath", "/private/tmp/ios-artifacts/au/E365AU.xcarchive",
      "-exportPath", "/private/tmp/ios-artifacts/au/export",
      "-exportOptionsPlist", "/private/tmp/ios-artifacts/au/ExportOptions.plist",
      "-allowProvisioningUpdates",
    ],
    cwd: "/private/tmp/ios-candidate/apps/ios",
  });

  const upload = buildUploadCommand({
    ipaPath: "/private/tmp/ios-artifacts/au/export/E365AU.ipa",
    keyId: "KEY-ID-SHOULD-NOT-PRINT",
    issuerId: "ISSUER-SHOULD-NOT-PRINT",
    privateKeyPath: "/private/credentials/AuthKey_KEY-ID-SHOULD-NOT-PRINT.p8",
  });
  assert.deepEqual(upload, {
    file: "xcrun",
    args: [
      "altool", "--upload-app",
      "-f", "/private/tmp/ios-artifacts/au/export/E365AU.ipa",
      "--api-key", "KEY-ID-SHOULD-NOT-PRINT",
      "--api-issuer", "ISSUER-SHOULD-NOT-PRINT",
      "--output-format", "json",
    ],
    env: { API_PRIVATE_KEYS_DIR: "/private/credentials" },
  });
  const displayed = redactCommand(upload);
  assert.doesNotMatch(displayed, /KEY-ID-SHOULD-NOT-PRINT|ISSUER-SHOULD-NOT-PRINT|private\/credentials/);
  assert.match(displayed, /--api-key \[REDACTED\]/);
  assert.match(displayed, /--api-issuer \[REDACTED\]/);
});

test("upload evidence rejects altool product errors and uses the exact App tuple when no delivery UUID exists", () => {
  assert.equal(
    extractUploadIdentifier(JSON.stringify({ "product-errors": [], "success-message": "uploaded" }), "asc:app:1.2.3:2046"),
    "asc:app:1.2.3:2046",
  );
  assert.throws(
    () => extractUploadIdentifier(JSON.stringify({
      "product-errors": [{ code: 90101, message: "invalid bundle" }],
    }), "asc:app:1.2.3:2046"),
    /product errors/i,
  );
});

test("artifact verification requires exact App identity and the Staging API", () => {
  const expected = {
    bundleId: "online.365english.app",
    marketingVersion: "1.2.3",
    buildNumber: "2046",
    apiUrl: STAGING_API_URL,
  };
  assert.deepEqual(verifyArtifactIdentity({ ...expected }, expected, "archive"), expected);

  for (const [field, value] of [
    ["bundleId", "online.365english.china"],
    ["marketingVersion", "1.2.4"],
    ["buildNumber", "2045"],
    ["apiUrl", "https://api.365english.online"],
  ]) {
    assert.throws(
      () => verifyArtifactIdentity({ ...expected, [field]: value }, expected, "IPA"),
      new RegExp(`IPA.*${field}`, "i"),
    );
  }
});

test("release binary scan rejects compiled debug IAP and storefront hooks", () => {
  assert.doesNotThrow(() => assertDebugHooksAbsent(Buffer.from("production StoreKit binary"), "E365AU"));
  for (const marker of [
    "E365_UI_TEST_IAP_MODE",
    "QuickLessonUITestIAPAPI",
    "E365ForceChinaStore",
  ]) {
    assert.throws(
      () => assertDebugHooksAbsent(Buffer.from(`binary-prefix ${marker} binary-suffix`), "E365AU"),
      /debug hook/i,
    );
  }
});

test("App Store Connect requests filter by exact App/version/build and use build linkage", () => {
  assert.equal(
    buildExactBuildQuery({
      appResourceId: "app-resource-id",
      marketingVersion: "1.2.3",
      buildNumber: "2046",
    }),
    "/v1/builds?filter%5Bapp%5D=app-resource-id&filter%5BpreReleaseVersion.version%5D=1.2.3&filter%5Bversion%5D=2046&limit=2",
  );
  assert.equal(
    buildGroupQuery({ appResourceId: "app-resource-id", groupName: "Dogfood AU" }),
    "/v1/betaGroups?filter%5Bapp%5D=app-resource-id&filter%5Bname%5D=Dogfood+AU&filter%5BisInternalGroup%5D=true&limit=2",
  );
  assert.deepEqual(buildGroupMembershipRequest({ groupId: "group-id", buildId: "build-id" }), {
    path: "/v1/betaGroups/group-id/relationships/builds",
    method: "POST",
    body: { data: [{ type: "builds", id: "build-id" }] },
  });
});

test("next build number strictly exceeds every integer App build", () => {
  assert.equal(nextBuildNumberFromBuilds([]), "1");
  assert.equal(nextBuildNumberFromBuilds([
    { attributes: { version: "2044" } },
    { attributes: { version: "2046" } },
    { attributes: { version: "2045" } },
  ]), "2047");
  assert.throws(
    () => nextBuildNumberFromBuilds([{ attributes: { version: "2.4" } }]),
    /non-integer.*strict/i,
  );
});

test("readback waits for the exact processed build, adds it to the exact internal group, and confirms membership", async () => {
  const state = { buildPolls: 0, membershipPolls: 0, memberBuildIds: new Set() };
  const client = {
    async findExactBuild() {
      state.buildPolls += 1;
      return {
        id: "build-resource-id",
        attributes: { processingState: state.buildPolls === 1 ? "PROCESSING" : "VALID" },
      };
    },
    async findExactInternalGroup() {
      return { id: "group-resource-id", attributes: { name: "Dogfood AU", isInternalGroup: true } };
    },
    async groupHasBuild(_groupId, buildId) {
      state.membershipPolls += 1;
      return state.memberBuildIds.has(buildId);
    },
    async addBuildToGroup(_groupId, buildId) {
      state.memberBuildIds.add(buildId);
    },
  };

  const evidence = await ensureProcessedAndInGroup({
    client,
    appResourceId: "app-resource-id",
    bundleId: "online.365english.app",
    marketingVersion: "1.2.3",
    buildNumber: "2046",
    groupName: "Dogfood AU",
    timeoutMs: 1_000,
    pollIntervalMs: 1,
    sleep: async () => {},
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  });

  assert.deepEqual(evidence, {
    bundleId: "online.365english.app",
    marketingVersion: "1.2.3",
    buildNumber: "2046",
    processed: true,
    processingStatus: "processed",
    testGroup: "Dogfood AU",
    membershipConfirmed: true,
    checkedAt: "2026-08-10T00:00:00.000Z",
  });
  assert.equal(state.buildPolls, 2);
  assert.equal(state.memberBuildIds.has("build-resource-id"), true);
  assert.ok(state.membershipPolls >= 2);
});

test("readback fails immediately when App Store Connect rejects processing", async () => {
  const client = {
    async findExactBuild() {
      return { id: "failed-build", attributes: { processingState: "FAILED" } };
    },
  };
  await assert.rejects(
    ensureProcessedAndInGroup({
      client,
      appResourceId: "app-resource-id",
      bundleId: "online.365english.app",
      marketingVersion: "1.2.3",
      buildNumber: "2046",
      groupName: "Dogfood AU",
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      sleep: async () => {},
    }),
    /processing failed/i,
  );
});

test("real mode fails closed on missing or mismatched private Apple configuration", () => {
  const common = {
    IOS_APP_ID: "au",
    IOS_SCHEME: "E365AU",
    IOS_BUNDLE_ID: "online.365english.app",
    IOS_MARKETING_VERSION: "1.2.3",
    IOS_TESTFLIGHT_GROUP: "Dogfood AU",
    STAGING_CANDIDATE_COMMIT: CANDIDATE_COMMIT,
    STAGING_REPO_PATH: "/repos/365wefun",
  };
  assert.doesNotThrow(() => validateEnvironment({ ...common, IOS_STAGING_DRY_RUN: "1" }, "stage"));
  assert.throws(() => validateEnvironment(common, "stage"), /ASC_KEY_ID/);
  assert.throws(
    () => validateEnvironment({
      ...common,
      ASC_KEY_ID: "ABC123",
      ASC_ISSUER_ID: "issuer",
      ASC_PRIVATE_KEY_PATH: "/private/credentials/wrong-name.p8",
    }, "stage", { checkFilesystem: false }),
    /AuthKey_ABC123\.p8/,
  );
  assert.throws(
    () => validateEnvironment({ ...common, IOS_STAGING_DRY_RUN: "1", IOS_TESTFLIGHT_GROUP: "" }, "stage"),
    /IOS_TESTFLIGHT_GROUP/,
  );
});

test("Candidate worktree is detached at the requested commit and removed after failure", async (t) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "ios-stage-source-"));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ios-stage-worktree-"));
  t.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", repoPath]);
  execFileSync("git", ["-C", repoPath, "config", "user.email", "ios-gate@example.invalid"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "iOS Gate Test"]);
  fs.writeFileSync(path.join(repoPath, "tracked.txt"), "candidate\n");
  execFileSync("git", ["-C", repoPath, "add", "tracked.txt"]);
  execFileSync("git", ["-C", repoPath, "commit", "--quiet", "-m", "candidate"]);
  const candidateCommit = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  let candidatePath;

  await assert.rejects(
    withCandidateWorktree({
      repoPath,
      candidateCommit,
      temporaryRoot,
      async operation(createdPath) {
        candidatePath = createdPath;
        assert.equal(
          execFileSync("git", ["-C", createdPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          candidateCommit,
        );
        assert.equal(
          execFileSync("git", ["-C", createdPath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
          "HEAD",
        );
        throw new Error("simulated archive failure");
      },
    }),
    /simulated archive failure/,
  );

  assert.equal(fs.existsSync(candidatePath), false);
  assert.doesNotMatch(
    execFileSync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], { encoding: "utf8" }),
    new RegExp(candidatePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("Candidate cleanup preserves a pre-existing candidate directory", async (t) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "ios-stage-source-"));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ios-stage-worktree-"));
  const candidatePath = path.join(temporaryRoot, "candidate");
  const sentinelPath = path.join(candidatePath, "keep.txt");
  t.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", repoPath]);
  execFileSync("git", ["-C", repoPath, "config", "user.email", "ios-gate@example.invalid"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "iOS Gate Test"]);
  fs.writeFileSync(path.join(repoPath, "tracked.txt"), "candidate\n");
  execFileSync("git", ["-C", repoPath, "add", "tracked.txt"]);
  execFileSync("git", ["-C", repoPath, "commit", "--quiet", "-m", "candidate"]);
  const candidateCommit = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  fs.mkdirSync(candidatePath);
  fs.writeFileSync(sentinelPath, "preserve\n");

  await assert.rejects(
    withCandidateWorktree({
      repoPath,
      candidateCommit,
      temporaryRoot,
      async operation() {
        throw new Error("must not run");
      },
    }),
    /candidate.*already exists/i,
  );
  assert.equal(fs.readFileSync(sentinelPath, "utf8"), "preserve\n");
});

test("credential-free stage dry-run prints only sanitized commands and one final evidence object", () => {
  const output = execFileSync(process.execPath, [SCRIPT_PATH, "stage"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      IOS_STAGING_DRY_RUN: "1",
      IOS_APP_ID: "cn",
      IOS_SCHEME: "E365CN",
      IOS_BUNDLE_ID: "online.365english.china",
      IOS_MARKETING_VERSION: "1.2.3",
      IOS_TESTFLIGHT_GROUP: "Dogfood CN",
      STAGING_CANDIDATE_COMMIT: CANDIDATE_COMMIT,
      STAGING_REPO_PATH: "/repos/365wefun",
      IOS_STAGING_DRY_RUN_BUILD_NUMBER: "2046",
      ASC_KEY_ID: "DRY-RUN-SECRET-KEY",
      ASC_ISSUER_ID: "DRY-RUN-SECRET-ISSUER",
      ASC_PRIVATE_KEY_PATH: "/private/credentials/AuthKey_DRY-RUN-SECRET-KEY.p8",
    },
  });
  const lines = output.trim().split(/\r?\n/);
  const evidence = JSON.parse(lines.at(-1));

  assert.deepEqual(
    {
      dryRun: evidence.dryRun,
      mode: evidence.mode,
      appId: evidence.appId,
      scheme: evidence.scheme,
      bundleId: evidence.bundleId,
      marketingVersion: evidence.marketingVersion,
      buildNumber: evidence.buildNumber,
      uploadId: evidence.uploadId,
    },
    {
      dryRun: true,
      mode: "stage",
      appId: "cn",
      scheme: "E365CN",
      bundleId: "online.365english.china",
      marketingVersion: "1.2.3",
      buildNumber: "2046",
      uploadId: "dry-run-cn-1.2.3-2046",
    },
  );
  assert.ok(Array.isArray(evidence.commands));
  assert.ok(evidence.commands.length >= 5);
  assert.doesNotMatch(output, /DRY-RUN-SECRET|private\/credentials/);
  assert.match(output, /-configuration Staging/);
  assert.doesNotMatch(output, /online\.365english\.app/);
});

test("readback dry-run cannot synthesize authoritative processing or group evidence", () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, "readback"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      IOS_STAGING_DRY_RUN: "1",
      IOS_APP_ID: "au",
      IOS_SCHEME: "E365AU",
      IOS_BUNDLE_ID: "online.365english.app",
      IOS_MARKETING_VERSION: "1.2.3",
      IOS_TESTFLIGHT_GROUP: "Dogfood AU",
      IOS_BUILD_NUMBER: "2046",
      IOS_UPLOAD_ID: "dry-run-upload",
      STAGING_CANDIDATE_COMMIT: CANDIDATE_COMMIT,
      STAGING_REPO_PATH: "/repos/365wefun",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /dry-run.*readback.*authoritative/i);
  assert.doesNotMatch(result.stdout, /"membershipConfirmed":true/);
});

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  STAGING_API_URL,
  assertDebugHooksAbsent,
  buildArchiveCommand,
  buildAppLockPaths,
  buildBuildSettingsCommand,
  buildExactBuildQuery,
  buildExportCommand,
  buildGroupMembershipRequest,
  buildGroupQuery,
  buildTestCommand,
  buildUploadCommand,
  createAppStoreConnectClient,
  createBuildPaths,
  createOperationControl,
  ensureProcessedAndInGroup,
  extractUploadIdentifier,
  nextBuildNumberFromBuilds,
  redactCommand,
  runCommand,
  validateEnvironment,
  verifyArtifactIdentity,
  withAppBuildReservation,
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

async function waitUntil(predicate, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function collectChild(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`reservation worker exited ${code}: ${stderr}`));
    });
  });
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
      "MARKETING_VERSION=1.2.3",
      "CURRENT_PROJECT_VERSION=2046",
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

    for (const setting of [
      "MARKETING_VERSION=1.2.3",
      "CURRENT_PROJECT_VERSION=2046",
      "API_BASE_URL=https://test-api.365english.online",
    ]) {
      assert.equal(testCommand.args.includes(setting), true);
      assert.equal(archive.args.includes(setting), true);
    }
  });
}

test("environment derives an internal deadline strictly shorter than the adapter timeout", () => {
  const config = validateEnvironment({
    IOS_STAGING_DRY_RUN: "1",
    IOS_APP_ID: "au",
    IOS_SCHEME: "E365AU",
    IOS_BUNDLE_ID: "online.365english.app",
    IOS_MARKETING_VERSION: "1.2.3",
    IOS_TESTFLIGHT_GROUP: "Dogfood AU",
    STAGING_CANDIDATE_COMMIT: CANDIDATE_COMMIT,
    STAGING_REPO_PATH: "/repos/365wefun",
    IOS_TESTFLIGHT_ADAPTER_TIMEOUT_MS: "1000",
  }, "stage");

  assert.equal(config.adapterTimeoutMs, 1000);
  assert.ok(config.internalTimeoutMs > 0);
  assert.ok(config.internalTimeoutMs < config.adapterTimeoutMs);
  assert.throws(
    () => validateEnvironment({
      IOS_STAGING_DRY_RUN: "1",
      IOS_APP_ID: "au",
      IOS_SCHEME: "E365AU",
      IOS_BUNDLE_ID: "online.365english.app",
      IOS_MARKETING_VERSION: "1.2.3",
      IOS_TESTFLIGHT_GROUP: "Dogfood AU",
      STAGING_CANDIDATE_COMMIT: CANDIDATE_COMMIT,
      STAGING_REPO_PATH: "/repos/365wefun",
      IOS_TESTFLIGHT_ADAPTER_TIMEOUT_MS: "1000",
      IOS_STAGING_INTERNAL_TIMEOUT_MS: "1000",
    }, "stage"),
    /internal.*shorter.*adapter/i,
  );
});

test("operation control aborts deterministically on its deadline and on termination signals", () => {
  for (const trigger of ["deadline", "SIGTERM", "SIGINT"]) {
    const signalSource = new EventEmitter();
    let scheduled;
    let cancelled = false;
    const control = createOperationControl({
      adapterTimeoutMs: 1000,
      internalTimeoutMs: 900,
      signalSource,
      schedule(callback, milliseconds) {
        assert.equal(milliseconds, 900);
        scheduled = callback;
        return { unref() {} };
      },
      cancel() {
        cancelled = true;
      },
    });

    if (trigger === "deadline") scheduled();
    else signalSource.emit(trigger);

    assert.equal(control.signal.aborted, true);
    assert.match(control.signal.reason.message, trigger === "deadline" ? /internal deadline/i : new RegExp(trigger));
    control.dispose();
    assert.equal(cancelled, true);
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
    assert.equal(signalSource.listenerCount("SIGINT"), 0);
  }
});

test("App Store Connect fetch is aborted by the internal deadline", async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ios-stage-abort-fetch-"));
  const keyId = "ABORT01";
  const keyPath = path.join(temporaryRoot, `AuthKey_${keyId}.p8`);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  let scheduled;
  const control = createOperationControl({
    adapterTimeoutMs: 1000,
    internalTimeoutMs: 900,
    signalSource: new EventEmitter(),
    schedule(callback) {
      scheduled = callback;
      return { unref() {} };
    },
    cancel() {},
  });
  t.after(() => control.dispose());
  const client = await createAppStoreConnectClient({
    keyId,
    issuerId: "11111111-2222-3333-4444-555555555555",
    privateKeyPath: keyPath,
  }, {
    signal: control.signal,
    fetchImpl(_url, options) {
      assert.equal(options.signal, control.signal);
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    },
  });

  const request = client.findApp("online.365english.app");
  scheduled();
  await assert.rejects(request, /internal deadline/i);
});

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

test("same-App concurrent staging reserves distinct build numbers and serializes through upload", async (t) => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ios-stage-lock-concurrent-"));
  t.after(() => fs.rmSync(lockRoot, { recursive: true, force: true }));
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstEntered;
  const firstStarted = new Promise((resolve) => { firstEntered = resolve; });
  const first = withAppBuildReservation({
    lockRoot,
    app: APPS.au,
    fetchRemoteBuilds: async () => [],
    async operation(buildNumber) {
      firstEntered(buildNumber);
      await firstGate;
      return buildNumber;
    },
  });
  assert.equal(await firstStarted, "1");

  let secondBlocked;
  const blocked = new Promise((resolve) => { secondBlocked = resolve; });
  let secondEntered = false;
  const second = withAppBuildReservation({
    lockRoot,
    app: APPS.au,
    pollIntervalMs: 1,
    async sleep() {
      secondBlocked();
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    fetchRemoteBuilds: async () => [],
    async operation(buildNumber) {
      secondEntered = true;
      return buildNumber;
    },
  });
  await blocked;
  assert.equal(secondEntered, false);
  releaseFirst();

  assert.deepEqual(await Promise.all([first, second]), ["1", "2"]);
});

test("same-App reservation is serialized across separate Node processes", async (t) => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ios-stage-lock-processes-"));
  const releasePath = path.join(lockRoot, "release-first");
  const moduleUrl = pathToFileURL(SCRIPT_PATH).href;
  t.after(() => fs.rmSync(lockRoot, { recursive: true, force: true }));
  const startWorker = (role) => {
    const source = `
import fs from "node:fs";
const { withAppBuildReservation } = await import(${JSON.stringify(moduleUrl)});
const lockRoot = ${JSON.stringify(lockRoot)};
const role = ${JSON.stringify(role)};
fs.writeFileSync(lockRoot + "/" + role + ".attempted", "1");
const result = await withAppBuildReservation({
  lockRoot,
  app: ${JSON.stringify(APPS.au)},
  pollIntervalMs: 2,
  fetchRemoteBuilds: async () => [],
  async operation(buildNumber) {
    fs.writeFileSync(lockRoot + "/" + role + ".entered", buildNumber);
    while (role === "first" && !fs.existsSync(${JSON.stringify(releasePath)})) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return buildNumber;
  },
});
console.log(result);
`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { child, result: collectChild(child) };
  };

  const first = startWorker("first");
  await waitUntil(() => fs.existsSync(path.join(lockRoot, "first.entered")));
  const second = startWorker("second");
  await waitUntil(() => fs.existsSync(path.join(lockRoot, "second.attempted")));
  assert.equal(fs.existsSync(path.join(lockRoot, "second.entered")), false);
  fs.writeFileSync(releasePath, "release\n");

  assert.deepEqual(await Promise.all([first.result, second.result]), ["1", "2"]);
});

test("AU and CN build reservations use separate lock keys and may proceed concurrently", async (t) => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ios-stage-lock-apps-"));
  t.after(() => fs.rmSync(lockRoot, { recursive: true, force: true }));
  const auPaths = buildAppLockPaths({ lockRoot, app: APPS.au });
  const cnPaths = buildAppLockPaths({ lockRoot, app: APPS.cn });
  assert.notEqual(auPaths.lockPath, cnPaths.lockPath);
  assert.notEqual(auPaths.reservationPath, cnPaths.reservationPath);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = [];
  let resolveEnteredBoth;
  const enteredBoth = new Promise((resolve) => { resolveEnteredBoth = resolve; });
  const reserve = (app) => withAppBuildReservation({
    lockRoot,
    app,
    fetchRemoteBuilds: async () => [],
    async operation(buildNumber) {
      entered.push(app.id);
      if (entered.length === 2) resolveEnteredBoth();
      await gate;
      return buildNumber;
    },
  });
  const au = reserve(APPS.au);
  const cn = reserve(APPS.cn);
  await enteredBoth;
  assert.deepEqual(new Set(entered), new Set(["au", "cn"]));
  release();
  assert.deepEqual(await Promise.all([au, cn]), ["1", "1"]);
});

test("stale dead-owner lock is recovered without reusing the highest reserved build", async (t) => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ios-stage-lock-stale-"));
  t.after(() => fs.rmSync(lockRoot, { recursive: true, force: true }));
  const paths = buildAppLockPaths({ lockRoot, app: APPS.au });
  fs.mkdirSync(paths.lockPath, { mode: 0o700 });
  fs.writeFileSync(path.join(paths.lockPath, "owner.json"), JSON.stringify({
    token: "stale-owner",
    pid: 2147483647,
    acquiredAt: Date.now() - 10_000,
  }), { mode: 0o600 });
  fs.writeFileSync(paths.reservationPath, JSON.stringify({ buildNumber: "7" }), { mode: 0o600 });

  const result = await withAppBuildReservation({
    lockRoot,
    app: APPS.au,
    staleMs: 100,
    isProcessAlive: () => false,
    fetchRemoteBuilds: async () => [{ attributes: { version: "5" } }],
    operation: async (buildNumber) => buildNumber,
  });

  assert.equal(result, "8");
  assert.equal(fs.existsSync(paths.lockPath), false);
  assert.equal(JSON.parse(fs.readFileSync(paths.reservationPath, "utf8")).buildNumber, "8");
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

test("partial worktree add failure reconciles the exact Git registration before returning", async (t) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "ios-stage-partial-add-source-"));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ios-stage-partial-add-worktree-"));
  const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ios-stage-partial-add-bin-"));
  const candidatePath = path.join(temporaryRoot, "candidate");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const gitWrapper = path.join(wrapperRoot, "git");
  const originalPath = process.env.PATH;
  t.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(wrapperRoot, { recursive: true, force: true }));
  t.after(() => { process.env.PATH = originalPath; });
  execFileSync(realGit, ["init", "--quiet", repoPath]);
  execFileSync(realGit, ["-C", repoPath, "config", "user.email", "ios-gate@example.invalid"]);
  execFileSync(realGit, ["-C", repoPath, "config", "user.name", "iOS Gate Test"]);
  fs.writeFileSync(path.join(repoPath, "tracked.txt"), "candidate\n");
  execFileSync(realGit, ["-C", repoPath, "add", "tracked.txt"]);
  execFileSync(realGit, ["-C", repoPath, "commit", "--quiet", "-m", "candidate"]);
  const candidateCommit = execFileSync(realGit, ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  fs.writeFileSync(gitWrapper, [
    "#!/bin/sh",
    "if [ \"$3\" = \"worktree\" ] && [ \"$4\" = \"add\" ]; then",
    `  ${JSON.stringify(realGit)} \"$@\"`,
    "  /bin/rm -rf -- \"$6\"",
    "  exit 73",
    "fi",
    "if [ \"$3\" = \"worktree\" ] && [ \"$4\" = \"remove\" ]; then",
    "  exit 74",
    "fi",
    `exec ${JSON.stringify(realGit)} \"$@\"`,
    "",
  ].join("\n"), { mode: 0o700 });
  process.env.PATH = `${wrapperRoot}${path.delimiter}${originalPath}`;
  let operationRan = false;

  await assert.rejects(
    withCandidateWorktree({
      repoPath,
      candidateCommit,
      temporaryRoot,
      async operation() {
        operationRan = true;
      },
    }),
    /Candidate worktree creation failed/i,
  );
  process.env.PATH = originalPath;

  assert.equal(operationRan, false);
  assert.equal(fs.existsSync(candidatePath), false);
  assert.doesNotMatch(
    execFileSync(realGit, ["-C", repoPath, "worktree", "list", "--porcelain"], { encoding: "utf8" }),
    new RegExp(candidatePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("internal deadline kills a spawned process group and still removes the Candidate worktree", {
  skip: process.platform === "win32",
}, async (t) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "ios-stage-deadline-source-"));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ios-stage-deadline-worktree-"));
  const pidPath = path.join(temporaryRoot, "children.json");
  const grandchildReadyPath = path.join(temporaryRoot, "grandchild-ready");
  t.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", repoPath]);
  execFileSync("git", ["-C", repoPath, "config", "user.email", "ios-gate@example.invalid"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "iOS Gate Test"]);
  fs.writeFileSync(path.join(repoPath, "tracked.txt"), "candidate\n");
  execFileSync("git", ["-C", repoPath, "add", "tracked.txt"]);
  execFileSync("git", ["-C", repoPath, "commit", "--quiet", "-m", "candidate"]);
  const candidateCommit = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  let scheduled;
  const control = createOperationControl({
    adapterTimeoutMs: 1000,
    internalTimeoutMs: 900,
    signalSource: new EventEmitter(),
    schedule(callback) {
      scheduled = callback;
      return { unref() {} };
    },
    cancel() {},
  });
  t.after(() => control.dispose());
  const grandchildSource = [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `fs.writeFileSync(${JSON.stringify(grandchildReadyPath)}, 'ready');`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const childSource = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: 'ignore' });`,
    `fs.writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  let candidatePath;
  const operation = withCandidateWorktree({
    repoPath,
    candidateCommit,
    temporaryRoot,
    async operation(createdPath) {
      candidatePath = createdPath;
      await runCommand({ file: process.execPath, args: ["-e", childSource] }, "fake Xcode child", {
        signal: control.signal,
        killGraceMs: 20,
      });
    },
  });

  await waitUntil(() => fs.existsSync(pidPath) && fs.existsSync(grandchildReadyPath));
  const pids = JSON.parse(fs.readFileSync(pidPath, "utf8"));
  t.after(() => {
    for (const pid of Object.values(pids)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  });
  assert.equal(processIsAlive(pids.parent), true);
  assert.equal(processIsAlive(pids.grandchild), true);
  scheduled();

  await assert.rejects(operation, /internal deadline/i);
  await waitUntil(() => !processIsAlive(pids.parent) && !processIsAlive(pids.grandchild));
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

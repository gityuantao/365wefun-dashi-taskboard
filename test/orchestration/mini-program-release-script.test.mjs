import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildDetachedCandidate,
  createMiniProgramStageHandler,
  createTrustedSandboxCapability,
  executeMiniProgramStage,
  inspectArtifact,
  readPrivateJsonNoFollow,
  runCli,
  validateStageInputs,
  validateDetachedCandidate,
} from "../../scripts/release-mini-program.mjs";
import { createWechatReleaseAdapter } from "../../orchestration/mini-program/wechat-command-adapter.mjs";

const execFile = promisify(execFileCallback);
const APP_ID = "wx1fdac5e27c6b5366";
const baseEvidence = { appId: APP_ID, version: "1.2.3", candidateCommit: "1".repeat(40), manifestChecksum: "manifest", artifactDigest: `sha256:${"a".repeat(64)}` };

async function fixtureRepo(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wechat-candidate-fixture-")));
  t.after(async () => {
    async function writable(target) {
      const info = await stat(target).catch(() => null);
      if (!info) return;
      if (info.isDirectory()) {
        await chmod(target, 0o700);
        for (const entry of await import("node:fs/promises").then(({ readdir }) => readdir(target))) await writable(path.join(target, entry));
      } else await chmod(target, 0o600);
    }
    await writable(root);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, "apps/mp"), { recursive: true });
  await mkdir(path.join(root, "artifacts"), { mode: 0o700 });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ private: true }));
  await writeFile(path.join(root, "apps/mp/source.txt"), "candidate-source\n");
  await execFile("git", ["init", "-q"], { cwd: root });
  await execFile("git", ["config", "user.name", "Test"], { cwd: root });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["commit", "-qm", "candidate"], { cwd: root });
  const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: root });
  return { root, candidateCommit: stdout.trim() };
}

function app(candidateCommit) {
  return {
    id: "wechat", appId: APP_ID, version: "1.2.3", description: `Candidate ${candidateCommit}`,
    sourceDirectory: "apps/mp", artifactDirectory: "dist/build/mp-weixin",
    buildCommand: ["npm", "run", "build:mp-weixin"], uploadCommand: ["node", "upload.mjs"],
    reviewCommand: ["node", "review.mjs"], releaseCommand: ["node", "release.mjs"],
    readbackCommand: ["node", "readback.mjs"], credentialsPath: "private/wechat.private.json",
    reviewConfigurationRef: "review/wechat",
  };
}

async function fakeBuildRunner(calls, file, args, options) {
  calls.push({ file, args: [...args], cwd: options.cwd });
  if (file === "git") return execFile(file, args, options);
  if (args.includes("build")) {
    const artifact = options.env.MINI_PROGRAM_BUILD_OUTPUT_DIR;
    await mkdir(artifact, { recursive: true });
    await writeFile(path.join(artifact, "project.config.json"), JSON.stringify({ appid: APP_ID }));
    await writeFile(path.join(artifact, "app.js"), "const api='https://api.365life.example/v1';\n");
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}

function fakeSandbox(calls, run = fakeBuildRunner) {
  return createTrustedSandboxCapability({
    implementationId: "test-trusted-sandbox-v1",
    profileId: "test-deny-network-v1",
    deniedRoots: ["/private/credentials", "/private/review"],
    execute: async ({ file, args, cwd, env, network, filesystem, processGroup, implementationId }) => {
      calls.push({ file, args: [...args], cwd, env, network, filesystem, processGroup, implementationId, sandbox: true });
      return {
        completion: run([], file, args, { cwd, env }),
        terminateProcessGroup: async () => { calls.push({ lifecycle: "terminate" }); },
        waitForProcessGroupExit: async () => { calls.push({ lifecycle: "group-exit" }); },
      };
    },
  });
}

test("detached Candidate build runs exact quality and production build commands, verifies identity, and cleans the worktree", async (t) => {
  const fixture = await fixtureRepo(t);
  const calls = [];
  const artifactRoot = path.join(fixture.root, "artifacts");
  const result = await buildDetachedCandidate({
    repoPath: fixture.root,
    candidateCommit: fixture.candidateCommit,
    manifestChecksum: "manifest-1",
    app: app(fixture.candidateCommit),
    productionApiAllowlist: ["https://api.365life.example/"],
    artifactRoot,
    runCommand: (...args) => fakeBuildRunner(calls, ...args),
    trustedSandbox: fakeSandbox(calls),
  });

  assert.deepEqual(calls.filter(({ file, sandbox }) => file === "pnpm" && sandbox).map(({ args }) => args), [
    ["--filter", "@e365/mp", "exec", "uni", "build", "-p", "mp-weixin"],
  ]);
  for (const call of calls.filter(({ sandbox }) => sandbox)) {
    assert.deepEqual(call.network, { mode: "deny-all", profileId: "test-deny-network-v1" });
    assert.equal(call.env.PATH, process.env.PATH ?? "");
    assert.equal(call.env.LANG, process.env.LANG ?? "C.UTF-8");
    assert.match(call.env.MINI_PROGRAM_BUILD_OUTPUT_DIR, /wechat-candidate-build-output-/);
    assert.deepEqual(call.filesystem.readOnlyRoots, [call.cwd]);
    assert.deepEqual(call.filesystem.writableRoots, [call.env.MINI_PROGRAM_BUILD_OUTPUT_DIR]);
    assert.ok(call.filesystem.deniedRoots.includes("/private/credentials"));
    assert.equal(call.processGroup.awaitExit, true);
  }
  const worktreeAdd = calls.find(({ file, args }) => file === "git" && args.includes("add"));
  assert.ok(worktreeAdd.args.includes("--detach"));
  assert.equal(worktreeAdd.args.at(-1), fixture.candidateCommit);
  assert.equal(result.appId, APP_ID);
  assert.equal(result.version, "1.2.3");
  assert.equal(result.candidateCommit, fixture.candidateCommit);
  assert.match(result.artifactDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(result.artifactSize > 0);
  assert.equal(result.artifactIdentity, `${APP_ID}:1.2.3:${result.artifactDigest}`);
  assert.equal((await stat(result.artifactPath)).isDirectory(), true);
  const { stdout } = await execFile("git", ["worktree", "list", "--porcelain"], { cwd: fixture.root });
  assert.doesNotMatch(stdout, /wechat-candidate-worktree-/);

  const repeated = await inspectArtifact({ artifactRoot, artifactPath: result.artifactPath, app: app(fixture.candidateCommit), candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1", productionApiAllowlist: ["https://api.365life.example/"] });
  assert.equal(repeated.artifactDigest, result.artifactDigest);
  assert.equal(repeated.artifactSize, result.artifactSize);
});

test("detached Candidate worktree cleanup is guaranteed after a failed build", async (t) => {
  const fixture = await fixtureRepo(t);
  const calls = [];
  await assert.rejects(buildDetachedCandidate({
    repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1",
    app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"],
    artifactRoot: path.join(fixture.root, "artifacts"),
    runCommand: async (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd });
      if (file === "git") return execFile(file, args, options);
      if (args.includes("build")) throw new Error("production build failed");
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    trustedSandbox: fakeSandbox(calls, async (_calls, _file, args) => {
      if (args.includes("build")) throw new Error("production build failed");
      return { stdout: "", stderr: "", exitCode: 0 };
    }),
  }), /production build failed/);
  assert.ok(calls.some(({ file, args }) => file === "git" && args.includes("remove") && args.includes("--force")));
  const { stdout } = await execFile("git", ["worktree", "list", "--porcelain"], { cwd: fixture.root });
  assert.doesNotMatch(stdout, /wechat-candidate-worktree-/);
});

test("detached Candidate setup failure removes its allocated temporary worktree directory", async (t) => {
  const fixture = await fixtureRepo(t);
  let allocatedPath;
  await assert.rejects(buildDetachedCandidate({
    repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1",
    app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"],
    artifactRoot: path.join(fixture.root, "artifacts"),
    runCommand: async (file, args) => {
      if (file === "git" && args.includes("add")) {
        allocatedPath = args.at(-2);
        throw new Error("worktree setup failed");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    trustedSandbox: fakeSandbox([]),
  }), /worktree setup failed/);
  await assert.rejects(stat(allocatedPath), (error) => error.code === "ENOENT");
});

test("partial worktree registration after add failure is discovered, removed, pruned, and verified", async (t) => {
  const fixture = await fixtureRepo(t);
  const calls = [];
  let registeredPath;
  await assert.rejects(buildDetachedCandidate({
    repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1",
    app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"],
    artifactRoot: path.join(fixture.root, "artifacts"), trustedSandbox: fakeSandbox([]),
    runCommand: async (file, args) => {
      calls.push([...args]);
      if (file === "git" && args.includes("add")) {
        registeredPath = args.at(-2);
        throw new Error("add failed after registry write");
      }
      if (args.includes("list")) return { stdout: registeredPath ? `worktree ${registeredPath}\n` : "" };
      if (args.includes("remove")) { registeredPath = undefined; return { stdout: "" }; }
      return { stdout: "" };
    },
  }), /add failed after registry write/);
  assert.ok(calls.some((args) => args.includes("list") && args.includes("--porcelain")));
  assert.ok(calls.some((args) => args.includes("remove") && args.includes("--force")));
  assert.ok(calls.some((args) => args.includes("prune")));
  assert.equal(registeredPath, undefined);
});

test("worktree registry cleanup failure is never swallowed even when owned directory removal succeeds", async (t) => {
  const fixture = await fixtureRepo(t);
  const calls = [];
  await assert.rejects(buildDetachedCandidate({
    repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1",
    app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"], artifactRoot: path.join(fixture.root, "artifacts"),
    runCommand: async (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd });
      if (file === "git" && args.includes("remove")) throw new Error("registry remove failed");
      return fakeBuildRunner([], file, args, options);
    },
    trustedSandbox: fakeSandbox(calls),
  }), /registry remove failed|cleanup/i);
  const removeCall = calls.find(({ args }) => args?.includes("remove"));
  assert.ok(calls.some(({ args }) => args?.includes("list") && args.includes("--porcelain")));
  await assert.rejects(stat(removeCall.args.at(-1)), (error) => error.code === "ENOENT");
});

test("detached build rejects descriptor and artifact output paths that escape owned roots", async (t) => {
  const fixture = await fixtureRepo(t);
  for (const overrides of [
    { sourceDirectory: "../outside" },
    { artifactDirectory: "../../outside" },
    { id: "../outside" },
  ]) {
    await assert.rejects(buildDetachedCandidate({
      repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1",
      app: { ...app(fixture.candidateCommit), ...overrides },
      productionApiAllowlist: ["https://api.365life.example/"], artifactRoot: path.join(fixture.root, "artifacts"),
      runCommand: (...args) => fakeBuildRunner([], ...args),
      trustedSandbox: fakeSandbox([]),
    }), /path|relative|escape/i);
  }
});

test("local Candidate execution defaults closed without a no-network sandbox proof", async (t) => {
  const fixture = await fixtureRepo(t);
  const input = { repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1", app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"], artifactRoot: path.join(fixture.root, "artifacts") };
  await assert.rejects(validateDetachedCandidate(input), /sandbox|network/i);
  await assert.rejects(buildDetachedCandidate(input), /sandbox|network/i);
  await assert.rejects(buildDetachedCandidate({ ...input, trustedSandbox: { implementationId: "forged" } }), /trusted sandbox|capability/i);
});

test("test stage only validates Candidate while build alone creates the published artifact", async (t) => {
  const fixture = await fixtureRepo(t);
  const calls = [];
  const base = { repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1", app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"], artifactRoot: path.join(fixture.root, "artifacts"), runCommand: (...args) => fakeBuildRunner(calls, ...args), trustedSandbox: fakeSandbox(calls) };
  const tested = await validateDetachedCandidate(base);
  assert.equal(tested.status, "validated");
  assert.deepEqual(calls.filter(({ sandbox }) => sandbox).map(({ args }) => args), [
    ["--filter", "@e365/mp", "lint"], ["--filter", "@e365/mp", "typecheck"], ["--filter", "@e365/mp", "test"],
  ]);
  assert.equal(calls.some(({ args }) => args?.includes("build")), false);
  const built = await buildDetachedCandidate(base);
  assert.match(built.artifactDigest, /^sha256:/);
  assert.deepEqual(calls.filter(({ sandbox }) => sandbox).slice(3).map(({ args }) => args), [
    ["--filter", "@e365/mp", "exec", "uni", "build", "-p", "mp-weixin"],
  ]);
});

test("canonical roots and every existing path component reject symlinks and escapes", async (t) => {
  const fixture = await fixtureRepo(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "wechat-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const repoLink = path.join(path.dirname(fixture.root), `repo-link-${Date.now()}`);
  const artifactLink = path.join(fixture.root, "artifact-link");
  await symlink(fixture.root, repoLink);
  await symlink(outside, artifactLink);
  t.after(() => rm(repoLink, { force: true }));
  const common = { candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1", app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"], trustedSandbox: fakeSandbox([]) };
  await assert.rejects(buildDetachedCandidate({ ...common, repoPath: repoLink, artifactRoot: path.join(fixture.root, "artifacts") }), /symlink|canonical/i);
  const nestedRoot = path.join(path.dirname(fixture.root), `nested-root-${Date.now()}`);
  await mkdir(nestedRoot);
  await symlink(path.dirname(fixture.root), path.join(nestedRoot, "component"));
  t.after(() => rm(nestedRoot, { recursive: true, force: true }));
  await assert.rejects(buildDetachedCandidate({ ...common, repoPath: path.join(nestedRoot, "component", path.basename(fixture.root)), artifactRoot: path.join(fixture.root, "artifacts") }), /symlink|canonical/i);
  await assert.rejects(buildDetachedCandidate({ ...common, repoPath: fixture.root, artifactRoot: artifactLink }), /symlink|canonical|owned/i);
  const symlinkSandbox = fakeSandbox([], async (_calls, _file, args, options) => {
    if (args.includes("build")) {
      await symlink(outside, path.join(options.env.MINI_PROGRAM_BUILD_OUTPUT_DIR, "linked"));
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  await assert.rejects(buildDetachedCandidate({ ...common, repoPath: fixture.root, artifactRoot: path.join(fixture.root, "artifacts"), trustedSandbox: symlinkSandbox }), /symlink|symbolic link|canonical|escape/i);
});

test("artifact root must be a private directory owned by the current user", async (t) => {
  const fixture = await fixtureRepo(t);
  const artifactRoot = path.join(fixture.root, "shared-artifacts");
  await mkdir(artifactRoot, { mode: 0o755 });
  await assert.rejects(buildDetachedCandidate({
    repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1",
    app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"], artifactRoot,
    trustedSandbox: fakeSandbox([]),
  }), /owned|private|0700/i);
});

test("artifact root must be pre-created by the trusted runtime", async (t) => {
  const fixture = await fixtureRepo(t);
  await assert.rejects(buildDetachedCandidate({
    repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1",
    app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"],
    artifactRoot: path.join(fixture.root, "not-created"), trustedSandbox: fakeSandbox([]),
  }), /pre-created|artifactRoot/i);
});

test("artifact publication hashes the private immutable copy and atomically renames those exact bytes", async (t) => {
  const fixture = await fixtureRepo(t);
  const calls = [];
  const result = await buildDetachedCandidate({
    repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1",
    app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"], artifactRoot: path.join(fixture.root, "artifacts"),
    runCommand: (...args) => fakeBuildRunner(calls, ...args), trustedSandbox: fakeSandbox(calls),
    snapshotHooks: {
      afterSourceOpen: async ({ source, relative }) => {
        if (relative !== "app.js") return;
        await rename(path.join(source, relative), path.join(source, `${relative}.original`));
        await writeFile(path.join(source, relative), "const api='https://evil.example/v10';\n");
      },
    },
  });
  assert.match(await readFile(path.join(result.artifactPath, "app.js"), "utf8"), /api\.365life\.example/);
  const verified = await inspectArtifact({ artifactRoot: path.join(fixture.root, "artifacts"), artifactPath: result.artifactPath, app: app(fixture.candidateCommit), candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1", productionApiAllowlist: ["https://api.365life.example/"] });
  assert.equal(verified.artifactDigest, result.artifactDigest);
});

test("artifact snapshot starts only after trusted sandbox completion and process-group quiescence", async (t) => {
  const fixture = await fixtureRepo(t);
  const events = [];
  const trustedSandbox = createTrustedSandboxCapability({
    implementationId: "test-lifecycle-sandbox-v1", profileId: "deny-all-v1",
    execute: async ({ env }) => ({
      completion: (async () => {
        events.push("completion");
        await mkdir(env.MINI_PROGRAM_BUILD_OUTPUT_DIR, { recursive: true });
        await writeFile(path.join(env.MINI_PROGRAM_BUILD_OUTPUT_DIR, "project.config.json"), JSON.stringify({ appid: APP_ID }));
        await writeFile(path.join(env.MINI_PROGRAM_BUILD_OUTPUT_DIR, "app.js"), "https://api.365life.example/v1");
      })(),
      terminateProcessGroup: async () => { events.push("terminate"); },
      waitForProcessGroupExit: async () => { events.push("group-exit"); },
    }),
  });
  await buildDetachedCandidate({
    repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1",
    app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"],
    artifactRoot: path.join(fixture.root, "artifacts"), trustedSandbox,
    snapshotHooks: { beforeEntryOpen: async () => { events.push("snapshot"); } },
  });
  assert.ok(events.indexOf("completion") < events.indexOf("group-exit"));
  assert.ok(events.indexOf("group-exit") < events.indexOf("snapshot"));
});

test("artifact snapshot rejects an intermediate directory replaced by a symlink during traversal", async (t) => {
  const fixture = await fixtureRepo(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "wechat-snapshot-race-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "escaped.js"), "https://evil.example/v1");
  let swapped = false;
  const trustedSandbox = createTrustedSandboxCapability({
    implementationId: "test-lifecycle-sandbox-v1", profileId: "deny-all-v1",
    execute: async ({ env }) => ({
      completion: (async () => {
        await mkdir(path.join(env.MINI_PROGRAM_BUILD_OUTPUT_DIR, "nested"), { recursive: true });
        await writeFile(path.join(env.MINI_PROGRAM_BUILD_OUTPUT_DIR, "project.config.json"), JSON.stringify({ appid: APP_ID }));
        await writeFile(path.join(env.MINI_PROGRAM_BUILD_OUTPUT_DIR, "nested/app.js"), "https://api.365life.example/v1");
      })(),
      terminateProcessGroup: async () => {}, waitForProcessGroupExit: async () => {},
    }),
  });
  await assert.rejects(buildDetachedCandidate({
    repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1",
    app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"],
    artifactRoot: path.join(fixture.root, "artifacts"), trustedSandbox,
    snapshotHooks: { beforeEntryOpen: async ({ source, relative }) => {
      if (relative !== "nested" || swapped) return;
      swapped = true;
      await rename(path.join(source, "nested"), path.join(source, "nested.original"));
      await symlink(outside, path.join(source, "nested"));
    } },
  }), /symlink|symbolic link|changed|escape/i);
  assert.equal(swapped, true);
});

test("sandbox command failure terminates and drains its process group before surfacing", async (t) => {
  const fixture = await fixtureRepo(t);
  const events = [];
  const trustedSandbox = createTrustedSandboxCapability({
    implementationId: "test-lifecycle-sandbox-v1", profileId: "deny-all-v1",
    execute: async () => ({
      completion: Promise.reject(new Error("sandboxed command failed")),
      terminateProcessGroup: async () => { events.push("terminate"); },
      waitForProcessGroupExit: async () => { events.push("group-exit"); },
    }),
  });
  await assert.rejects(validateDetachedCandidate({
    repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1",
    app: app(fixture.candidateCommit), trustedSandbox,
  }), /sandboxed command failed/);
  assert.deepEqual(events, ["terminate", "group-exit"]);
});

test("artifact inspection rejects wrong App ID, non-production endpoints, non-allowlisted APIs, and secret material", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wechat-artifact-")));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const descriptor = app("1".repeat(40));
  async function rejected(project, source, pattern) {
    await writeFile(path.join(root, "project.config.json"), JSON.stringify(project));
    await writeFile(path.join(root, "app.js"), source);
    await chmod(root, 0o700);
    await assert.rejects(inspectArtifact({ artifactRoot: root, artifactPath: root, app: descriptor, candidateCommit: "1".repeat(40), manifestChecksum: "manifest", productionApiAllowlist: ["https://api.365life.example/v1"] }), pattern);
  }
  await rejected({ appid: "wx0000000000000000" }, "https://api.365life.example/v1", /App ID/i);
  await rejected({ appid: APP_ID }, "https://test-api.365life.example/v1", /test|debug/i);
  await rejected({ appid: APP_ID }, "https://evil.example/v1", /allowlist/i);
  await rejected({ appid: APP_ID }, "https://api.365life.example/v10evil", /allowlist/i);
  await rejected({ appid: APP_ID }, "-----BEGIN PRIVATE KEY-----", /secret|private key/i);
});

test("independent artifact inspection accepts only canonical paths inside its owned root", async (t) => {
  const owned = await realpath(await mkdtemp(path.join(os.tmpdir(), "wechat-owned-artifacts-")));
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "wechat-outside-artifact-")));
  t.after(() => Promise.all([rm(owned, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  for (const root of [owned, outside]) {
    await writeFile(path.join(root, "project.config.json"), JSON.stringify({ appid: APP_ID }));
    await writeFile(path.join(root, "app.js"), "https://api.365life.example/v1");
  }
  await assert.rejects(inspectArtifact({ artifactRoot: owned, artifactPath: outside, app: app("1".repeat(40)), candidateCommit: "1".repeat(40), manifestChecksum: "manifest", productionApiAllowlist: ["https://api.365life.example/v1"] }), /owned|outside|escape/i);
  const link = path.join(owned, "linked");
  await symlink(outside, link);
  await assert.rejects(inspectArtifact({ artifactRoot: owned, artifactPath: link, app: app("1".repeat(40)), candidateCommit: "1".repeat(40), manifestChecksum: "manifest", productionApiAllowlist: ["https://api.365life.example/v1"] }), /symlink|canonical/i);
});

test("stage validation accepts only allowlisted inputs and requires 0600 regular private descriptors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wechat-private-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const credentialsPath = path.join(root, "wechat.private.json");
  const reviewPath = path.join(root, "review.private.json");
  await writeFile(credentialsPath, JSON.stringify({ privateKey: "secret" }), { mode: 0o600 });
  await writeFile(reviewPath, JSON.stringify({ "review/wechat": { category: "Education" } }), { mode: 0o600 });
  const environment = {
    MINI_PROGRAM_STAGE: "upload", MINI_PROGRAM_APP_ID: APP_ID, MINI_PROGRAM_VERSION: "1.2.3",
    MINI_PROGRAM_CREDENTIALS_PATH: credentialsPath, MINI_PROGRAM_REVIEW_CONFIGURATION_PATH: reviewPath,
    MINI_PROGRAM_REVIEW_CONFIGURATION_REF: "review/wechat", MINI_PROGRAM_IDEMPOTENCY_KEY: "idem-1",
    MINI_PROGRAM_EVIDENCE: JSON.stringify({ artifactDigest: `sha256:${"a".repeat(64)}` }),
    MINI_PROGRAM_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`, MINI_PROGRAM_ARTIFACT_IDENTITY: "artifact-1",
    MINI_PROGRAM_ARTIFACT_SIZE: "10", PRODUCTION_CANDIDATE_COMMIT: "1".repeat(40),
    PRODUCTION_CANDIDATE_REF: `refs/heads/release-candidate/v/${"1".repeat(40)}`,
    PRODUCTION_MANIFEST_CHECKSUM: "manifest", PRODUCTION_VERSION_ID: "version-1",
  };
  const config = await validateStageInputs(environment);
  assert.equal(config.appId, APP_ID);
  assert.equal(config.credentials, undefined);
  await chmod(credentialsPath, 0o644);
  await assert.rejects(validateStageInputs(environment), /0600|private/i);
  await chmod(credentialsPath, 0o600);
  await mkdir(path.join(root, "directory.private.json"));
  await assert.rejects(validateStageInputs({ ...environment, MINI_PROGRAM_CREDENTIALS_PATH: path.join(root, "directory.private.json") }), /regular file/i);
  await assert.rejects(validateStageInputs({ ...environment, UNEXPECTED_SECRET: "must-not-be-consumed" }), /unsupported.*UNEXPECTED_SECRET/i);
});

test("private descriptors load only inside the child stage boundary and fake protocol receives stable identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wechat-child-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const credentialsPath = path.join(root, "wechat.private.json");
  const reviewPath = path.join(root, "review.private.json");
  await writeFile(credentialsPath, JSON.stringify({ accessToken: "child-only" }), { mode: 0o600 });
  await writeFile(reviewPath, JSON.stringify({ "review/wechat": { category: "Education" } }), { mode: 0o600 });
  const config = {
    stage: "submitReview", appId: APP_ID, version: "1.2.3", candidateCommit: "1".repeat(40),
    manifestChecksum: "manifest", idempotencyKey: "idem-1", credentialsPath, reviewConfigurationPath: reviewPath,
    reviewConfigurationRef: "review/wechat", evidence: { uploadId: "upload-1", artifactDigest: `sha256:${"a".repeat(64)}` },
  };
  let reads = 0;
  const result = await executeMiniProgramStage(config, {
    readPrivateFile: async (...args) => { reads += 1; return readFile(...args); },
    stageRunner: async (request) => {
      assert.equal(request.credentials.accessToken, "child-only");
      assert.deepEqual(request.reviewConfiguration, { category: "Education" });
      assert.equal(request.idempotencyKey, "idem-1");
      return { appId: APP_ID, version: "1.2.3", candidateCommit: "1".repeat(40), manifestChecksum: "manifest", artifactDigest: config.evidence.artifactDigest, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1" };
    },
  });
  assert.equal(reads, 2);
  assert.equal(result.reviewId, "review-1");
});

test("private descriptors use no-follow same-fd validation and reject symlink or race substitution", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wechat-private-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "target.private.json");
  const link = path.join(root, "link.private.json");
  await writeFile(target, JSON.stringify({ accessToken: "secret" }), { mode: 0o600 });
  await symlink(target, link);
  await assert.rejects(readPrivateJsonNoFollow(link), /symlink|nofollow|private descriptor/i);

  let opened;
  const value = await readPrivateJsonNoFollow(target, {
    openFile: async (filePath, flags) => {
      assert.notEqual(flags & fsConstants.O_NOFOLLOW, 0);
      opened = await open(filePath, flags);
      await rename(filePath, `${filePath}.replaced`);
      await writeFile(filePath, JSON.stringify({ accessToken: "attacker" }), { mode: 0o600 });
      return opened;
    },
  });
  assert.equal(value.accessToken, "secret");
});

test("adapter-shaped CLI environments execute all nine stages without duplicate local work", async () => {
  const stages = ["test", "build", "inspectArtifact", "upload", "readUpload", "submitReview", "readReview", "release", "readLive"];
  const observed = [];
  for (const stage of stages) {
    const local = ["test", "build", "inspectArtifact"].includes(stage);
    const env = {
      PATH: "/bin", LANG: "C.UTF-8", MINI_PROGRAM_STAGE: stage, MINI_PROGRAM_APP_ID: APP_ID,
      MINI_PROGRAM_VERSION: "1.2.3", MINI_PROGRAM_EVIDENCE: JSON.stringify({ artifactDigest: `sha256:${"a".repeat(64)}` }),
      MINI_PROGRAM_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`, MINI_PROGRAM_ARTIFACT_SIZE: "10",
      MINI_PROGRAM_ARTIFACT_IDENTITY: "artifact-1", PRODUCTION_CANDIDATE_COMMIT: "1".repeat(40),
      PRODUCTION_CANDIDATE_REF: `refs/heads/release-candidate/v/${"1".repeat(40)}`,
      PRODUCTION_MANIFEST_CHECKSUM: "manifest", PRODUCTION_VERSION_ID: "version-1",
      ...(local ? {
        MINI_PROGRAM_APP_IDENTITY: "wechat", MINI_PROGRAM_SOURCE_DIRECTORY: "apps/mp",
        MINI_PROGRAM_ARTIFACT_DIRECTORY: "dist/build/mp-weixin", MINI_PROGRAM_DESCRIPTION: `Candidate ${"1".repeat(40)}`,
        MINI_PROGRAM_REPO_PATH: "/repo", MINI_PROGRAM_ARTIFACT_ROOT: "/owned",
        MINI_PROGRAM_PRODUCTION_API_ALLOWLIST: '["https://api.example/v1"]',
      } : {
        MINI_PROGRAM_CREDENTIALS_PATH: "/private/credentials", MINI_PROGRAM_REVIEW_CONFIGURATION_PATH: "/private/review",
        MINI_PROGRAM_REVIEW_CONFIGURATION_REF: "review/wechat", MINI_PROGRAM_IDEMPOTENCY_KEY: "stable",
      }),
    };
    await runCli({ environment: env, write: () => {}, validateInputs: (value) => validateStageInputs(value, { checkFilesystem: false }), executeStage: async (config) => { observed.push(config.stage); return baseEvidence; } });
  }
  assert.deepEqual(observed, stages);
});

test("the actual adapter and CLI boundary compose through real executeMiniProgramStage for all nine stages", async (t) => {
  const fixture = await fixtureRepo(t);
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "wechat-nine-stage-private-"));
  t.after(() => rm(privateRoot, { recursive: true, force: true }));
  const credentialsPath = path.join(privateRoot, "credentials.private.json");
  const reviewConfigurationPath = path.join(privateRoot, "review.private.json");
  await writeFile(credentialsPath, JSON.stringify({ token: "fake-only" }), { mode: 0o600 });
  await writeFile(reviewConfigurationPath, JSON.stringify({ "review/wechat": { category: "Education" } }), { mode: 0o600 });
  const artifactRoot = path.join(fixture.root, "artifacts");
  const stages = [];
  const manifest = { versionId: "version-1", candidateCommit: fixture.candidateCommit, candidateRef: `refs/heads/release-candidate/v/${fixture.candidateCommit}`, checksum: "manifest" };
  const descriptor = app(fixture.candidateCommit);
  const trustedSandbox = fakeSandbox(stages, fakeBuildRunner);
  const executeStage = createMiniProgramStageHandler({
    trustedSandbox,
    runCommand: (...args) => fakeBuildRunner(stages, ...args),
    stageRunner: async (config) => {
      stages.push({ externalStage: config.stage });
      const common = { appId: APP_ID, version: descriptor.version, candidateCommit: manifest.candidateCommit, manifestChecksum: manifest.checksum, artifactDigest: config.evidence.artifactDigest };
      if (config.stage === "upload") return { ...common, uploadId: "upload-1" };
      if (config.stage === "readUpload") return { ...common, uploadId: "upload-1", authoritative: true };
      if (config.stage === "submitReview") return { ...common, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1" };
      if (config.stage === "readReview") return { ...common, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1", reviewStatus: "approved", authoritative: true };
      if (config.stage === "release") return { ...common, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1", releaseId: "release-1" };
      return { ...common, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1", releaseId: "release-1", liveId: "live-1", liveStatus: "live", authoritative: true };
    },
  });
  const adapter = createWechatReleaseAdapter({
    command: ["fake"], credentialsPath, reviewConfigurationPath,
    repoPath: fixture.root, artifactRoot, productionApiAllowlist: ["https://api.365life.example/v1"],
    runCommand: async (_file, _args, { env }) => {
      let output = "";
      await runCli({
        environment: env,
        write: (value) => { output = value; },
        executeStage,
      });
      return { stdout: output, stderr: "", exitCode: 0 };
    },
  });
  let lineage = {};
  for (const stage of ["test", "build", "inspectArtifact", "upload", "readUpload", "submitReview", "readReview", "release", "readLive"]) {
    const next = await adapter[stage]({ manifest, app: descriptor, evidence: lineage, idempotencyKey: "stable" });
    lineage = { ...lineage, ...next };
  }
  assert.deepEqual(stages.filter(({ externalStage }) => externalStage).map(({ externalStage }) => externalStage), ["upload", "readUpload", "submitReview", "readReview", "release", "readLive"]);
  assert.equal(lineage.liveStatus, "live");
});

test("unclassified mutation stage-runner errors become non-deterministic external-unknown JSON", async () => {
  let output = "";
  await runCli({
    environment: { MINI_PROGRAM_STAGE: "upload" }, write: (value) => { output = value; },
    validateInputs: async () => ({ stage: "upload" }),
    executeStage: async () => { throw new Error("socket vanished after request"); },
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.error.classification, "external_unknown");
  assert.equal(parsed.error.deterministic, false);
});

test("CLI emits exactly one bounded sanitized final JSON object", async () => {
  const writes = [];
  await runCli({
    environment: { MINI_PROGRAM_STAGE: "readLive" },
    write: (value) => writes.push(value),
    executeStage: async () => ({ ok: false, error: { classification: "external_unknown", message: `Authorization: Bearer abcdefgh.ijklmnop.qrstuvwx\n${"x".repeat(30_000)}` } }),
    validateInputs: async () => ({ stage: "readLive" }),
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].trim().split(/\r?\n/).length, 1);
  assert.ok(Buffer.byteLength(writes[0]) <= 16_385);
  assert.doesNotMatch(writes[0], /abcdefgh|Authorization|[\u0000-\u001f\u007f]/u);
  assert.doesNotThrow(() => JSON.parse(writes[0]));
});

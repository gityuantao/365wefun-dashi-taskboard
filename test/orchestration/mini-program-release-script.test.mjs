import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  buildDetachedCandidate,
  createMiniProgramStageHandler,
  executeMiniProgramStage,
  inspectArtifact,
  readPrivateJsonNoFollow,
  runCli,
  runCliMain,
  validateStageInputs,
  validateDetachedCandidate,
} from "../../scripts/release-mini-program.mjs";
import { createWechatReleaseAdapter } from "../../orchestration/mini-program/wechat-command-adapter.mjs";
import * as trustedRuntimeLoader from "../../orchestration/mini-program/trusted-runtime-loader.mjs";
const { createTrustedMiniProgramRuntimeLoader } = trustedRuntimeLoader;
import { createTrustedMiniProgramTestRuntime } from "../fixtures/trusted-mini-program-runtime/runtime-loader.mjs";
import { configureFakeSandboxProvider, exportOwnedArtifact } from "../fixtures/trusted-mini-program-runtime/sandbox-providers/fake.mjs";

const execFile = promisify(execFileCallback);
const APP_ID = "wx1fdac5e27c6b5366";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baseEvidence = { appId: APP_ID, version: "1.2.3", candidateCommit: "1".repeat(40), manifestChecksum: "manifest", artifactDigest: `sha256:${"a".repeat(64)}` };

function providerEvidence(entries) {
  const hash = createHash("sha256");
  let artifactSize = 0;
  for (const { relative, content } of entries.toSorted((left, right) => Buffer.compare(Buffer.from(left.relative), Buffer.from(right.relative)))) {
    artifactSize += content.length;
    hash.update(Buffer.from(`${relative}\0${content.length}\0`));
    hash.update(content);
  }
  return { artifactSize, artifactDigest: `sha256:${hash.digest("hex")}` };
}

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
    buildCommand: ["pnpm", "--filter", "@e365/mp", "exec", "uni", "build", "-p", "mp-weixin"], uploadCommand: ["node", "upload.mjs"],
    reviewCommand: ["node", "review.mjs"], releaseCommand: ["node", "release.mjs"],
    readbackCommand: ["node", "readback.mjs"], credentialsPath: "private/wechat.private.json",
    reviewConfigurationRef: "review/wechat",
  };
}

async function fakeBuildRunner(calls, file, args, options) {
  calls.push({ file, args: [...args], cwd: options.cwd });
  if (file === "git") return execFile(file, args, options);
  if (args.includes("build")) {
    const artifact = options.outputRoot;
    await mkdir(artifact, { recursive: true });
    await writeFile(path.join(artifact, "project.config.json"), JSON.stringify({ appid: APP_ID }));
    await writeFile(path.join(artifact, "app.js"), "const api='https://api.365life.example/v1';\n");
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}

async function fakeRuntime(calls, run = fakeBuildRunner, sessionOverrides = {}) {
  configureFakeSandboxProvider((request) => {
    const { file, args, cwd, env, network, filesystem, processGroup, implementationId } = request;
    calls.push({ file, args: [...args], cwd, env, network, filesystem, processGroup, implementationId, sandbox: true });
    const outputRoot = filesystem.mounts[0].targetPath;
    return {
      start: async () => run([], file, args, { cwd, env, outputRoot }),
      terminate: async () => { calls.push({ lifecycle: "terminate" }); },
      wait: async () => { calls.push({ lifecycle: "group-exit" }); },
      exportArtifact: ({ ownedArtifactRoot }) => exportOwnedArtifact({ sourceRoot: outputRoot, ownedArtifactRoot }),
      ...sessionOverrides,
    };
  });
  return createTrustedMiniProgramTestRuntime();
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
    trustedRuntime: await fakeRuntime(calls),
  });

  assert.deepEqual(calls.filter(({ file, sandbox }) => file === "pnpm" && sandbox).map(({ args }) => args), [
    ["--filter", "@e365/mp", "exec", "uni", "build", "-p", "mp-weixin"],
  ]);
  for (const call of calls.filter(({ sandbox }) => sandbox)) {
    assert.deepEqual(call.network, { mode: "deny-all", profileId: "spawned-deny-all-v1" });
    assert.equal(call.env.PATH, "/usr/bin:/bin");
    assert.equal(call.env.LANG, "C.UTF-8");
    assert.equal(call.env.MINI_PROGRAM_BUILD_OUTPUT_DIR, undefined);
    assert.deepEqual(call.filesystem.readOnlyRoots, [call.cwd]);
    assert.match(call.filesystem.writableRoots[0], /wechat-candidate-build-output-/);
    assert.equal(call.filesystem.mounts[0].sourcePath, path.join(call.cwd, "apps/mp/dist/build/mp-weixin"));
    assert.equal(call.filesystem.mounts[0].targetPath, call.filesystem.writableRoots[0]);
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
    trustedRuntime: await fakeRuntime(calls, async (_calls, _file, args) => {
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
    trustedRuntime: await fakeRuntime([]),
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
    artifactRoot: path.join(fixture.root, "artifacts"), trustedRuntime: await fakeRuntime([]),
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
    trustedRuntime: await fakeRuntime(calls),
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
      trustedRuntime: await fakeRuntime([]),
    }), /path|relative|escape/i);
  }
});

test("local Candidate execution defaults closed without a no-network sandbox proof", async (t) => {
  const fixture = await fixtureRepo(t);
  const input = { repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1", app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"], artifactRoot: path.join(fixture.root, "artifacts") };
  await assert.rejects(validateDetachedCandidate(input), /sandbox|network|trusted runtime/i);
  await assert.rejects(buildDetachedCandidate(input), /sandbox|network|trusted runtime/i);
  await assert.rejects(buildDetachedCandidate({ ...input, trustedRuntime: { implementationId: "forged" } }), /trusted sandbox provider/i);
});

test("test stage only validates Candidate while build alone creates the published artifact", async (t) => {
  const fixture = await fixtureRepo(t);
  const calls = [];
  const base = { repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1", app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"], artifactRoot: path.join(fixture.root, "artifacts"), runCommand: (...args) => fakeBuildRunner(calls, ...args), trustedRuntime: await fakeRuntime(calls) };
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
  const common = { candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1", app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"], trustedRuntime: await fakeRuntime([]) };
  await assert.rejects(buildDetachedCandidate({ ...common, repoPath: repoLink, artifactRoot: path.join(fixture.root, "artifacts") }), /symlink|canonical/i);
  const nestedRoot = path.join(path.dirname(fixture.root), `nested-root-${Date.now()}`);
  await mkdir(nestedRoot);
  await symlink(path.dirname(fixture.root), path.join(nestedRoot, "component"));
  t.after(() => rm(nestedRoot, { recursive: true, force: true }));
  await assert.rejects(buildDetachedCandidate({ ...common, repoPath: path.join(nestedRoot, "component", path.basename(fixture.root)), artifactRoot: path.join(fixture.root, "artifacts") }), /symlink|canonical/i);
  await assert.rejects(buildDetachedCandidate({ ...common, repoPath: fixture.root, artifactRoot: artifactLink }), /symlink|canonical|owned/i);
});

test("artifact root must be a private directory owned by the current user", async (t) => {
  const fixture = await fixtureRepo(t);
  const artifactRoot = path.join(fixture.root, "shared-artifacts");
  await mkdir(artifactRoot, { mode: 0o755 });
  await assert.rejects(buildDetachedCandidate({
    repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1",
    app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"], artifactRoot,
    trustedRuntime: await fakeRuntime([]),
  }), /owned|private|0700/i);
});

test("artifact root must be pre-created by the trusted runtime", async (t) => {
  const fixture = await fixtureRepo(t);
  await assert.rejects(buildDetachedCandidate({
    repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1",
    app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"],
    artifactRoot: path.join(fixture.root, "not-created"), trustedRuntime: await fakeRuntime([]),
  }), /pre-created|artifactRoot/i);
});

test("artifact publication hashes only the provider-exported owned artifact", async (t) => {
  const fixture = await fixtureRepo(t);
  const calls = [];
  const result = await buildDetachedCandidate({
    repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1",
    app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"], artifactRoot: path.join(fixture.root, "artifacts"),
    runCommand: (...args) => fakeBuildRunner(calls, ...args), trustedRuntime: await fakeRuntime(calls),
  });
  assert.match(await readFile(path.join(result.artifactPath, "app.js"), "utf8"), /api\.365life\.example/);
  const verified = await inspectArtifact({ artifactRoot: path.join(fixture.root, "artifacts"), artifactPath: result.artifactPath, app: app(fixture.candidateCommit), candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1", productionApiAllowlist: ["https://api.365life.example/"] });
  assert.equal(verified.artifactDigest, result.artifactDigest);
});

test("provider export starts only after sandbox completion and process-group quiescence", async (t) => {
  const fixture = await fixtureRepo(t);
  const events = [];
  const trustedRuntime = await fakeRuntime(events, async (_calls, _file, _args, { outputRoot }) => {
    events.push({ lifecycle: "completion" });
    await writeFile(path.join(outputRoot, "project.config.json"), JSON.stringify({ appid: APP_ID }));
    await writeFile(path.join(outputRoot, "app.js"), "https://api.365life.example/v1");
    return { exitCode: 0 };
  });
  await buildDetachedCandidate({
    repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1",
    app: app(fixture.candidateCommit), productionApiAllowlist: ["https://api.365life.example/"],
    artifactRoot: path.join(fixture.root, "artifacts"), trustedRuntime,
  });
  assert.ok(events.findIndex(({ lifecycle }) => lifecycle === "completion") < events.findIndex(({ lifecycle }) => lifecycle === "group-exit"));
});

test("sandbox command failure terminates and drains its process group before surfacing", async (t) => {
  const fixture = await fixtureRepo(t);
  const events = [];
  const trustedRuntime = await fakeRuntime(events, async () => { throw new Error("sandboxed command failed"); });
  await assert.rejects(validateDetachedCandidate({
    repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1",
    app: app(fixture.candidateCommit), trustedRuntime,
  }), /sandboxed command failed/);
  assert.deepEqual(events.filter(({ lifecycle }) => lifecycle).map(({ lifecycle }) => lifecycle), ["terminate", "group-exit"]);
});

test("sandbox lifecycle drains start throw, invalid session, nonzero result, and wait rejection", async (t) => {
  const fixture = await fixtureRepo(t);
  const input = { repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1", app: app(fixture.candidateCommit) };
  for (const scenario of [
    { name: "start throw", overrides: { start: async () => { throw new Error("start failed"); } }, expected: ["terminate", "group-exit"] },
    { name: "nonzero", overrides: { start: async () => ({ exitCode: 7 }) }, expected: ["terminate", "group-exit"] },
    { name: "wait reject", makeOverrides: (events) => ({
      wait: async () => { events.push({ lifecycle: "wait-attempt" }); if (events.filter(({ lifecycle }) => lifecycle === "wait-attempt").length === 1) throw new Error("wait failed"); },
    }), expected: ["wait-attempt", "terminate", "wait-attempt"] },
  ]) {
    const events = [];
    const runtime = await fakeRuntime(events, async () => ({ exitCode: 0 }), scenario.makeOverrides?.(events) ?? scenario.overrides);
    await assert.rejects(validateDetachedCandidate({ ...input, trustedRuntime: runtime }), /failed|unsuccessfully/i, scenario.name);
    assert.deepEqual(events.filter(({ lifecycle }) => lifecycle).map(({ lifecycle }) => lifecycle), scenario.expected, scenario.name);
  }
  configureFakeSandboxProvider(() => ({ terminate: async () => {}, wait: async () => {} }));
  const invalidRuntime = await createTrustedMiniProgramTestRuntime();
  await assert.rejects(validateDetachedCandidate({ ...input, trustedRuntime: invalidRuntime }), /invalid lifecycle session/i);
});

test("sandbox completion requires an explicit finite integer zero exit code and drains every invalid completion", async (t) => {
  const fixture = await fixtureRepo(t);
  const input = { repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1", app: app(fixture.candidateCommit) };
  for (const completion of [undefined, {}, { exitCode: Number.NaN }, { exitCode: 0.5 }, { code: Infinity }]) {
    const events = [];
    const runtime = await fakeRuntime(events, async () => completion);
    await assert.rejects(validateDetachedCandidate({ ...input, trustedRuntime: runtime }), /exit code|completion|unsuccessfully/i);
    assert.deepEqual(events.filter(({ lifecycle }) => lifecycle).map(({ lifecycle }) => lifecycle), ["terminate", "group-exit"]);
  }
});

test("test-only unit runtime accepts only its fixed fake modules", () => {
  const runtime = createTrustedMiniProgramTestRuntime();
  assert.equal(runtime.provider.implementationId, "spawned-test-provider-v1");
  for (const moduleName of ["../fake.mjs", "/tmp/fake.mjs", "nested/fake.mjs"]) {
    assert.throws(() => createTrustedMiniProgramTestRuntime({ sandboxProviderModule: moduleName }), /relative allowlisted/i);
  }
});

test("production runtime authority cannot be redirected or supplied by production test helpers", async () => {
  assert.equal(trustedRuntimeLoader.createTrustedMiniProgramTestRuntime, undefined);
  let imported = false;
  const runtime = await createTrustedMiniProgramRuntimeLoader({
    projectRoot: "/tmp/attacker-root",
    sandboxProviderModule: "missing-provider.mjs",
    stageRunnerModule: "missing-runner.mjs",
    importModule: async () => {
      imported = true;
      return { default: { implementationId: "forged", profileId: "forged", createSession() {} } };
    },
  });
  assert.notEqual(runtime.provider.implementationId, "forged");
  assert.equal(imported, false);
});

test("trusted module validation rejects symlinks in the fixed root chain before canonicalization", async (t) => {
  const actual = await mkdtemp(path.join(os.tmpdir(), "wechat-loader-actual-"));
  const linked = path.join(os.tmpdir(), `wechat-loader-linked-${process.pid}-${Date.now()}`);
  t.after(() => Promise.all([rm(actual, { recursive: true, force: true }), rm(linked, { force: true })]));
  await mkdir(path.join(actual, "orchestration/mini-program/sandbox-providers"), { recursive: true });
  await mkdir(path.join(actual, "orchestration/mini-program/stage-runners"), { recursive: true });
  await writeFile(path.join(actual, "orchestration/mini-program/sandbox-providers/provider.mjs"), "export default {}\n", { mode: 0o600 });
  await writeFile(path.join(actual, "orchestration/mini-program/stage-runners/runner.mjs"), "export default () => ({})\n", { mode: 0o600 });
  await symlink(actual, linked);
  await assert.rejects(trustedRuntimeLoader.validateTrustedRuntimeModuleAtFixedRoot(
    path.join(linked, "orchestration/mini-program"), "sandbox-providers", "provider.mjs",
  ), /symlink|canonical|real director/i);
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

test("provider artifact entries require canonical unique bounded POSIX paths and buffers", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wechat-artifact-entries-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = Buffer.from(JSON.stringify({ appid: APP_ID }));
  const source = Buffer.from("https://api.365life.example/v1");
  const common = {
    artifactRoot: root, artifactPath: root, app: app("1".repeat(40)), candidateCommit: "1".repeat(40),
    manifestChecksum: "manifest", productionApiAllowlist: ["https://api.365life.example/v1"],
  };
  for (const entries of [
    [{ relative: "project.config.json", content: descriptor }, { relative: "/app.js", content: source }],
    [{ relative: "project.config.json", content: descriptor }, { relative: "../app.js", content: source }],
    [{ relative: "project.config.json", content: descriptor }, { relative: "./app.js", content: source }],
    [{ relative: "project.config.json", content: descriptor }, { relative: "app\u0000.js", content: source }],
    [{ relative: "project.config.json", content: descriptor }, { relative: "app.js", content: source }, { relative: "app.js", content: source }],
    [{ relative: "project.config.json", content: descriptor }, { relative: "app.js", content: "not-a-buffer" }],
  ]) {
    await assert.rejects(inspectArtifact({ ...common, exportedArtifact: { readFiles: async () => entries } }), /artifact|path|relative|duplicate|buffer/i);
  }
});

test("artifact digest is entry-order independent and must match provider published path, size, and digest", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wechat-artifact-order-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [
    { relative: "project.config.json", content: Buffer.from(JSON.stringify({ appid: APP_ID })) },
    { relative: "app.js", content: Buffer.from("https://api.365life.example/v1") },
  ];
  const common = {
    artifactRoot: root, artifactPath: root, app: app("1".repeat(40)), candidateCommit: "1".repeat(40),
    manifestChecksum: "manifest", productionApiAllowlist: ["https://api.365life.example/v1"],
  };
  const evidence = providerEvidence(entries);
  const first = await inspectArtifact({ ...common, exportedArtifact: { artifactPath: root, ...evidence, readFiles: async () => entries } });
  const second = await inspectArtifact({ ...common, exportedArtifact: {
    artifactPath: root, artifactSize: first.artifactSize, artifactDigest: first.artifactDigest,
    readFiles: async () => entries.toReversed().map((entry) => Object.freeze({ ...entry })),
  } });
  assert.equal(second.artifactDigest, first.artifactDigest);
  assert.equal(second.artifactSize, first.artifactSize);
  for (const exportedArtifact of [
    { artifactPath: root, readFiles: async () => entries },
    { artifactPath: path.join(root, "other"), artifactSize: first.artifactSize, artifactDigest: first.artifactDigest, readFiles: async () => entries },
    { artifactPath: root, artifactSize: first.artifactSize + 1, artifactDigest: first.artifactDigest, readFiles: async () => entries },
    { artifactPath: root, artifactSize: first.artifactSize, artifactDigest: `sha256:${"f".repeat(64)}`, readFiles: async () => entries },
  ]) {
    await assert.rejects(inspectArtifact({ ...common, exportedArtifact }), /published|path|size|digest|mismatch/i);
  }
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
  await writeFile(credentialsPath, JSON.stringify({ appId: APP_ID, privateKey: "secret" }), { mode: 0o600 });
  await writeFile(reviewPath, JSON.stringify({ "review/wechat": { category: "Education", commandDefinitions: { uploadCommand: ["node", "upload.mjs"] } } }), { mode: 0o600 });
  const environment = {
    MINI_PROGRAM_STAGE: "upload", MINI_PROGRAM_APP_ID: APP_ID, MINI_PROGRAM_VERSION: "1.2.3",
    MINI_PROGRAM_CREDENTIALS_PATH: credentialsPath, MINI_PROGRAM_REVIEW_CONFIGURATION_PATH: reviewPath,
    MINI_PROGRAM_REVIEW_CONFIGURATION_REF: "review/wechat", MINI_PROGRAM_IDEMPOTENCY_KEY: "idem-1",
    MINI_PROGRAM_EVIDENCE: JSON.stringify({ artifactDigest: `sha256:${"a".repeat(64)}` }),
    MINI_PROGRAM_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`, MINI_PROGRAM_ARTIFACT_IDENTITY: "artifact-1",
    MINI_PROGRAM_ARTIFACT_SIZE: "10", PRODUCTION_CANDIDATE_COMMIT: "1".repeat(40),
    PRODUCTION_CANDIDATE_REF: `refs/heads/release-candidate/v/${"1".repeat(40)}`,
    PRODUCTION_MANIFEST_CHECKSUM: "manifest", PRODUCTION_VERSION_ID: "version-1",
    MINI_PROGRAM_FROZEN_COMMAND_ID: "uploadCommand", MINI_PROGRAM_FROZEN_COMMAND: '["node","upload.mjs"]',
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
  await writeFile(credentialsPath, JSON.stringify({ appId: APP_ID, accessToken: "child-only" }), { mode: 0o600 });
  await writeFile(reviewPath, JSON.stringify({ "review/wechat": { category: "Education", commandDefinitions: { reviewCommand: ["node", "review.mjs"] } } }), { mode: 0o600 });
  const config = {
    stage: "submitReview", appId: APP_ID, version: "1.2.3", candidateCommit: "1".repeat(40),
    manifestChecksum: "manifest", idempotencyKey: "idem-1", credentialsPath, reviewConfigurationPath: reviewPath,
    reviewConfigurationRef: "review/wechat", frozenCommandId: "reviewCommand", frozenCommand: ["node", "review.mjs"],
    evidence: { uploadId: "upload-1", artifactDigest: `sha256:${"a".repeat(64)}` },
  };
  let reads = 0;
  const result = await executeMiniProgramStage(config, {
    readPrivateFile: async (...args) => { reads += 1; return readFile(...args); },
    stageRunner: async (request) => {
      assert.equal(request.credentials.accessToken, "child-only");
      assert.equal(request.reviewConfiguration.category, "Education");
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
      MINI_PROGRAM_FROZEN_COMMAND_ID: local ? "buildCommand" : ({ upload: "uploadCommand", submitReview: "reviewCommand", release: "releaseCommand" }[stage] ?? "readbackCommand"),
      MINI_PROGRAM_FROZEN_COMMAND: JSON.stringify(local ? app("1".repeat(40)).buildCommand : ({ upload: ["node", "upload.mjs"], submitReview: ["node", "review.mjs"], release: ["node", "release.mjs"] }[stage] ?? ["node", "readback.mjs"])),
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
  await writeFile(credentialsPath, JSON.stringify({ appId: APP_ID, token: "fake-only" }), { mode: 0o600 });
  await writeFile(reviewConfigurationPath, JSON.stringify({ "review/wechat": { category: "Education", commandDefinitions: {
    uploadCommand: ["node", "upload.mjs"], reviewCommand: ["node", "review.mjs"],
    releaseCommand: ["node", "release.mjs"], readbackCommand: ["node", "readback.mjs"],
  } } }), { mode: 0o600 });
  const artifactRoot = path.join(fixture.root, "artifacts");
  const stages = [];
  const manifest = { versionId: "version-1", candidateCommit: fixture.candidateCommit, candidateRef: `refs/heads/release-candidate/v/${fixture.candidateCommit}`, checksum: "manifest" };
  const descriptor = app(fixture.candidateCommit);
  const trustedRuntime = await fakeRuntime(stages, fakeBuildRunner);
  const executeStage = createMiniProgramStageHandler({
    trustedRuntime,
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

test("a spawned child uses the production loader and fixed runner for a local read-only stage", { skip: process.platform !== "darwin" }, async (t) => {
  const fixture = await fixtureRepo(t);
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "wechat-spawned-private-"));
  t.after(() => rm(privateRoot, { recursive: true, force: true }));
  const credentialsPath = path.join(privateRoot, "credentials.private.json");
  const reviewConfigurationPath = path.join(privateRoot, "review.private.json");
  await writeFile(credentialsPath, JSON.stringify({ appId: APP_ID, token: "spawned-local-only" }), { mode: 0o600 });
  const manifest = { versionId: "version-1", candidateCommit: fixture.candidateCommit, candidateRef: `refs/heads/release-candidate/v/${fixture.candidateCommit}`, checksum: "manifest" };
  const descriptor = app(fixture.candidateCommit);
  const frozenRead = [process.execPath, "-e", [
    "let s=''", "process.stdin.on('data',c=>s+=c)",
    `process.stdin.on('end',()=>{const v=JSON.parse(s);process.stdout.write(JSON.stringify({appId:v.appId,version:v.version,candidateCommit:v.candidateCommit,manifestChecksum:v.manifestChecksum,artifactDigest:v.evidence.artifactDigest,status:'absent',authoritative:true}))})`,
  ].join(";")];
  descriptor.readbackCommand = frozenRead;
  await writeFile(reviewConfigurationPath, JSON.stringify({ "review/wechat": { category: "Education", commandDefinitions: { readbackCommand: frozenRead } } }), { mode: 0o600 });
  const adapter = createWechatReleaseAdapter({
    command: [process.execPath, path.join(PROJECT_ROOT, "test/fixtures/trusted-mini-program-runtime/bootstrap.mjs")],
    credentialsPath, reviewConfigurationPath, repoPath: fixture.root, artifactRoot: path.join(fixture.root, "artifacts"),
    productionApiAllowlist: ["https://api.365life.example/v1"],
    cwd: PROJECT_ROOT,
  });
  const result = await adapter.readUpload({ manifest, app: descriptor, evidence: baseEvidence });
  assert.equal(result.status, "absent");
  assert.equal(result.authoritative, true);
  assert.equal(result.appId, APP_ID);
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

test("production modules expose no test authority or alternate trusted-root issuer", async () => {
  const loaderSource = await readFile(path.join(PROJECT_ROOT, "orchestration/mini-program/trusted-runtime-loader.mjs"), "utf8");
  const cliSource = await readFile(path.join(PROJECT_ROOT, "scripts/release-mini-program.mjs"), "utf8");
  assert.doesNotMatch(loaderSource, /testAuthority|TEST_TRUSTED_ROOT|TEST_RUNTIME_HELPER/);
  assert.doesNotMatch(cliSource, /testAuthority/);
  assert.doesNotMatch(loaderSource, /sandboxProviderModule\s*[,}]/);
  assert.doesNotMatch(loaderSource, /stageRunnerModule\s*[,}]/);
});

test("network command drift is rejected before credentials or runner access", async () => {
  const accesses = [];
  await assert.rejects(executeMiniProgramStage({
    stage: "upload", appId: APP_ID, version: "1.2.3", candidateCommit: "1".repeat(40),
    manifestChecksum: "manifest", credentialsPath: "/credentials", reviewConfigurationPath: "/review",
    reviewConfigurationRef: "review/wechat", frozenCommandId: "uploadCommand",
    frozenCommand: [process.execPath, "frozen.mjs"], evidence: {},
  }, {
    readPrivateFile: async (filePath) => {
      accesses.push(filePath);
      return JSON.stringify(filePath === "/review"
        ? { "review/wechat": { commandDefinitions: { uploadCommand: [process.execPath, "drifted.mjs"] } } }
        : { appId: APP_ID });
    },
    stageRunner: async () => { accesses.push("runner"); return {}; },
  }), /frozen.*command|command.*drift/i);
  assert.deepEqual(accesses, ["/review"]);
});

test("credentials require the authoritative frozen App ID before runner access", async () => {
  let runnerCalled = false;
  await assert.rejects(executeMiniProgramStage({
    stage: "readUpload", appId: APP_ID, version: "1.2.3", candidateCommit: "1".repeat(40),
    manifestChecksum: "manifest", credentialsPath: "/credentials", reviewConfigurationPath: "/review",
    reviewConfigurationRef: "review/wechat", frozenCommandId: "readbackCommand",
    frozenCommand: [process.execPath, "read.mjs"], evidence: {},
  }, {
    readPrivateFile: async (filePath) => JSON.stringify(filePath === "/review"
      ? { "review/wechat": { commandDefinitions: { readbackCommand: [process.execPath, "read.mjs"] } } }
      : { appId: "wx0000000000000000", token: "private" }),
    stageRunner: async () => { runnerCalled = true; return {}; },
  }), /credential.*App ID|App ID.*credential/i);
  assert.equal(runnerCalled, false);
});

test("temporary Candidate and output roots are canonical before reaching the provider", async (t) => {
  const fixture = await fixtureRepo(t);
  const calls = [];
  const provider = {
    implementationId: "test", profileId: "deny", deniedRoots: [],
    createSession(request) {
      calls.push(request);
      return {
        start: async () => ({ exitCode: 0 }), terminate: async () => {}, wait: async () => {},
        exportArtifact: async () => { throw new Error("unused"); },
      };
    },
  };
  await validateDetachedCandidate({
    repoPath: fixture.root, candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest",
    app: app(fixture.candidateCommit), runCommand: execFile, trustedRuntime: { provider },
  });
  for (const call of calls) {
    assert.equal(path.dirname(call.cwd), await realpath(path.dirname(call.cwd)));
    assert.equal(path.dirname(call.filesystem.writableRoots[0]), await realpath(path.dirname(call.filesystem.writableRoots[0])));
    assert.doesNotMatch(call.cwd, /^\/var\//u);
    assert.doesNotMatch(call.filesystem.writableRoots[0], /^\/var\//u);
  }
});

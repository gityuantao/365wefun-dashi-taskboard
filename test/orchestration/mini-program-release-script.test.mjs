import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildDetachedCandidate,
  executeMiniProgramStage,
  inspectArtifact,
  runCli,
  validateStageInputs,
} from "../../scripts/release-mini-program.mjs";

const execFile = promisify(execFileCallback);
const APP_ID = "wx1fdac5e27c6b5366";

async function fixtureRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wechat-candidate-fixture-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  await mkdir(path.join(root, "apps/mp"), { recursive: true });
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
    const artifact = path.join(options.cwd, "apps/mp/dist/build/mp-weixin");
    await mkdir(artifact, { recursive: true });
    await writeFile(path.join(artifact, "project.config.json"), JSON.stringify({ appid: APP_ID }));
    await writeFile(path.join(artifact, "app.js"), "const api='https://api.365life.example/v1';\n");
  }
  return { stdout: "", stderr: "", exitCode: 0 };
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
  });

  assert.deepEqual(calls.filter(({ file }) => file === "pnpm").map(({ args }) => args), [
    ["--filter", "@e365/mp", "lint"],
    ["--filter", "@e365/mp", "typecheck"],
    ["--filter", "@e365/mp", "test"],
    ["--filter", "@e365/mp", "exec", "uni", "build", "-p", "mp-weixin"],
  ]);
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

  const repeated = await inspectArtifact({ artifactPath: result.artifactPath, app: app(fixture.candidateCommit), candidateCommit: fixture.candidateCommit, manifestChecksum: "manifest-1", productionApiAllowlist: ["https://api.365life.example/"] });
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
      if (args.includes("typecheck")) throw new Error("typecheck failed");
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  }), /typecheck failed/);
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
  }), /worktree setup failed/);
  await assert.rejects(stat(allocatedPath), (error) => error.code === "ENOENT");
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
    }), /path|relative|escape/i);
  }
});

test("artifact inspection rejects wrong App ID, non-production endpoints, non-allowlisted APIs, and secret material", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wechat-artifact-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const descriptor = app("1".repeat(40));
  async function rejected(project, source, pattern) {
    await writeFile(path.join(root, "project.config.json"), JSON.stringify(project));
    await writeFile(path.join(root, "app.js"), source);
    await assert.rejects(inspectArtifact({ artifactPath: root, app: descriptor, candidateCommit: "1".repeat(40), manifestChecksum: "manifest", productionApiAllowlist: ["https://api.365life.example/"] }), pattern);
  }
  await rejected({ appid: "wx0000000000000000" }, "https://api.365life.example/v1", /App ID/i);
  await rejected({ appid: APP_ID }, "https://test-api.365life.example/v1", /test|debug/i);
  await rejected({ appid: APP_ID }, "https://evil.example/v1", /allowlist/i);
  await rejected({ appid: APP_ID }, "-----BEGIN PRIVATE KEY-----", /secret|private key/i);
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
    MINI_PROGRAM_APP_DESCRIPTOR: JSON.stringify(app("1".repeat(40))),
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

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createWechatReleaseAdapter,
  runCommandBoundary,
} from "../../orchestration/mini-program/wechat-command-adapter.mjs";

const APP_ID = "wx1fdac5e27c6b5366";
const SHA = "1".repeat(40);
const DIGEST = `sha256:${"a".repeat(64)}`;

const manifest = {
  versionId: "version-1.2.3",
  candidateCommit: SHA,
  candidateRef: `refs/heads/release-candidate/version-1.2.3/${SHA}`,
  checksum: "manifest-checksum-123",
};

const app = {
  id: "wechat",
  appId: APP_ID,
  version: "1.2.3",
  description: `Candidate ${SHA}`,
  sourceDirectory: "apps/mp",
  buildCommand: ["npm", "run", "build:mp-weixin"],
  artifactDirectory: "dist/build/mp-weixin",
  uploadCommand: ["node", "upload.mjs"],
  reviewCommand: ["node", "review.mjs"],
  releaseCommand: ["node", "release.mjs"],
  readbackCommand: ["node", "readback.mjs"],
  credentialsPath: "private/wechat.private.json",
  reviewConfigurationRef: "review/wechat",
};

const baseEvidence = {
  appId: APP_ID,
  version: "1.2.3",
  candidateCommit: SHA,
  manifestChecksum: manifest.checksum,
  artifactDigest: DIGEST,
  artifactSize: 321,
  artifactIdentity: `${APP_ID}:1.2.3:${DIGEST}`,
};

function final(value) {
  return { stdout: `diagnostic line\n${JSON.stringify(value)}\n`, stderr: "", exitCode: 0 };
}

test("every stage receives the exact frozen Candidate, App, version, artifact, and an allowlisted child environment", async () => {
  const calls = [];
  const outputs = {
    test: baseEvidence,
    build: baseEvidence,
    inspectArtifact: baseEvidence,
    upload: { ...baseEvidence, uploadId: "upload-1", externalRequestId: "request-1" },
    readUpload: { ...baseEvidence, uploadId: "upload-1", externalRequestId: "request-1", authoritative: true },
    submitReview: { ...baseEvidence, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1" },
    readReview: { ...baseEvidence, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1", reviewStatus: "approved", authoritative: true },
    release: { ...baseEvidence, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1", reviewStatus: "approved", releaseId: "release-1", authoritative: true },
    readLive: { ...baseEvidence, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1", releaseId: "release-1", liveId: "live-1", liveStatus: "live", authoritative: true },
  };
  const adapter = createWechatReleaseAdapter({
    command: [process.execPath, "safe-wechat-gateway.mjs"],
    credentialsPath: "/private/wechat.private.json",
    reviewConfigurationPath: "/private/review.private.json",
    repoPath: "/repo",
    artifactRoot: "/owned-artifacts",
    productionApiAllowlist: ["https://api.365life.example/v1"],
    sandboxProviderModule: "darwin-sandbox.mjs",
    stageRunnerModule: "wechat-stage.mjs",
    runCommand: async (file, args, options) => {
      calls.push({ file, args, options });
      return final(outputs[options.env.MINI_PROGRAM_STAGE]);
    },
  });
  for (const stage of Object.keys(outputs)) {
    const result = await adapter[stage]({ manifest, app, idempotencyKey: "idem-1", evidence: outputs[stage] });
    assert.equal(result.appId, APP_ID);
  }

  assert.equal(calls.length, 9);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.file, process.execPath);
    assert.deepEqual(call.args, ["safe-wechat-gateway.mjs"]);
    assert.equal(call.options.env.MINI_PROGRAM_STAGE, Object.keys(outputs)[index]);
    assert.equal(call.options.env.MINI_PROGRAM_APP_ID, APP_ID);
    assert.equal(call.options.env.MINI_PROGRAM_VERSION, "1.2.3");
    assert.equal(call.options.env.PRODUCTION_CANDIDATE_COMMIT, SHA);
    assert.equal(call.options.env.PRODUCTION_CANDIDATE_REF, manifest.candidateRef);
    assert.equal(call.options.env.PRODUCTION_MANIFEST_CHECKSUM, manifest.checksum);
    assert.equal(call.options.env.MINI_PROGRAM_ARTIFACT_DIGEST, DIGEST);
    const local = ["test", "build", "inspectArtifact"].includes(call.options.env.MINI_PROGRAM_STAGE);
    assert.equal(call.options.env.MINI_PROGRAM_IDEMPOTENCY_KEY, local ? undefined : "idem-1");
    assert.equal(call.options.env.MINI_PROGRAM_CREDENTIALS_PATH, local ? undefined : "/private/wechat.private.json");
    assert.equal(call.options.env.MINI_PROGRAM_REVIEW_CONFIGURATION_PATH, local ? undefined : "/private/review.private.json");
    assert.equal(call.options.env.MINI_PROGRAM_REVIEW_CONFIGURATION_REF, local ? undefined : "review/wechat");
    assert.equal(call.options.env.MINI_PROGRAM_APP_DESCRIPTOR, undefined);
    assert.equal(call.options.env.MINI_PROGRAM_REPO_PATH, local ? "/repo" : undefined);
    assert.equal(call.options.env.MINI_PROGRAM_ARTIFACT_ROOT, local ? "/owned-artifacts" : undefined);
    assert.equal(call.options.env.MINI_PROGRAM_SANDBOX_PROVIDER_MODULE, "darwin-sandbox.mjs");
    assert.equal(call.options.env.MINI_PROGRAM_STAGE_RUNNER_MODULE, "wechat-stage.mjs");
    assert.equal(call.options.env.MINI_PROGRAM_PRODUCTION_API_ALLOWLIST, local ? '["https://api.365life.example/v1"]' : undefined);
    assert.equal(call.options.env.NODE_OPTIONS, undefined);
    assert.equal(call.options.env.HOME, undefined);
    assert.equal(call.options.env.AWS_SECRET_ACCESS_KEY, undefined);
    const common = ["LANG", "MINI_PROGRAM_APP_ID", "MINI_PROGRAM_ARTIFACT_DIGEST",
      "MINI_PROGRAM_ARTIFACT_IDENTITY", "MINI_PROGRAM_ARTIFACT_SIZE", "MINI_PROGRAM_EVIDENCE",
      "MINI_PROGRAM_SANDBOX_PROVIDER_MODULE", "MINI_PROGRAM_STAGE_RUNNER_MODULE",
      "MINI_PROGRAM_STAGE", "MINI_PROGRAM_VERSION", "PATH", "PRODUCTION_CANDIDATE_COMMIT",
      "PRODUCTION_CANDIDATE_REF", "PRODUCTION_MANIFEST_CHECKSUM", "PRODUCTION_VERSION_ID"];
    const stageSpecific = local
      ? ["MINI_PROGRAM_APP_IDENTITY", "MINI_PROGRAM_ARTIFACT_DIRECTORY", "MINI_PROGRAM_ARTIFACT_ROOT",
        "MINI_PROGRAM_DESCRIPTION", "MINI_PROGRAM_PRODUCTION_API_ALLOWLIST", "MINI_PROGRAM_REPO_PATH",
        "MINI_PROGRAM_SOURCE_DIRECTORY"]
      : ["MINI_PROGRAM_CREDENTIALS_PATH", "MINI_PROGRAM_IDEMPOTENCY_KEY",
        "MINI_PROGRAM_REVIEW_CONFIGURATION_PATH", "MINI_PROGRAM_REVIEW_CONFIGURATION_REF"];
    assert.deepEqual(Object.keys(call.options.env).sort(), [...common, ...stageSpecific].sort());
  }
});

test("the parent adapter never reads credential descriptors", async () => {
  let invoked = false;
  const adapter = createWechatReleaseAdapter({
    command: ["fake"], credentialsPath: "/definitely/missing/private.json",
    reviewConfigurationPath: "/also/missing/review.json",
    repoPath: "/repo", artifactRoot: "/artifacts", productionApiAllowlist: ["https://api.example/v1"],
    runCommand: async () => { invoked = true; return final(baseEvidence); },
  });
  await adapter.test({ manifest, app, evidence: baseEvidence });
  assert.equal(invoked, true);
});

test("local stage child environments cannot exfiltrate inherited or private-path secrets", async () => {
  const seen = [];
  const adapter = createWechatReleaseAdapter({
    command: ["fake"], credentialsPath: "/private/credentials", reviewConfigurationPath: "/private/review",
    repoPath: "/repo", artifactRoot: "/owned", productionApiAllowlist: ["https://api.example/v1"],
    runCommand: async (_file, _args, options) => { seen.push(options.env); return final(baseEvidence); },
  });
  for (const stage of ["test", "build", "inspectArtifact"]) await adapter[stage]({ manifest, app, evidence: baseEvidence });
  for (const env of seen) {
    const serialized = JSON.stringify(env);
    assert.doesNotMatch(serialized, /credentials|review\/wechat|upload\.mjs|release\.mjs|readback\.mjs/i);
    assert.equal(env.HOME, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  }
});

test("unclassified mutation runner exceptions are external-unknown and reconcile", async () => {
  const stages = [];
  const adapter = createWechatReleaseAdapter({
    command: ["fake"], credentialsPath: "/p", reviewConfigurationPath: "/r",
    runCommand: async (_file, _args, { env }) => {
      stages.push(env.MINI_PROGRAM_STAGE);
      if (env.MINI_PROGRAM_STAGE === "upload") throw new Error("socket vanished");
      return final({ ...baseEvidence, uploadId: "upload-1", authoritative: true });
    },
  });
  const result = await adapter.upload({ manifest, app, evidence: baseEvidence, idempotencyKey: "stable" });
  assert.deepEqual(stages, ["upload", "readUpload"]);
  assert.equal(result.uploadId, "upload-1");
});

test("successful mutation stages require stable stage-specific lineage", async () => {
  for (const [stage, evidence, output, pattern] of [
    ["upload", baseEvidence, baseEvidence, /uploadId/i],
    ["submitReview", { ...baseEvidence, uploadId: "upload-1" }, { ...baseEvidence, reviewId: "review-1" }, /uploadId|reviewSubmissionId/i],
    ["release", { ...baseEvidence, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1", reviewStatus: "approved", authoritative: true }, { ...baseEvidence, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1", releaseId: "" }, /releaseId/i],
  ]) {
    const adapter = createWechatReleaseAdapter({ command: ["fake"], credentialsPath: "/p", reviewConfigurationPath: "/r", runCommand: async () => final(output) });
    await assert.rejects(adapter[stage]({ manifest, app, evidence, idempotencyKey: "stable" }), pattern);
  }
});

test("mutation stages require stable idempotency and reconcile unknown outcomes through authoritative lookup", async () => {
  const stages = [];
  const adapter = createWechatReleaseAdapter({
    command: ["fake"], credentialsPath: "/private/credentials", reviewConfigurationPath: "/private/review",
    runCommand: async (_file, _args, { env }) => {
      stages.push(env.MINI_PROGRAM_STAGE);
      if (["upload", "submitReview", "release"].includes(env.MINI_PROGRAM_STAGE)) {
        const error = new Error("connection reset after request");
        error.failureClassification = "external_unknown";
        throw error;
      }
      const evidence = JSON.parse(env.MINI_PROGRAM_EVIDENCE);
      if (env.MINI_PROGRAM_STAGE === "readUpload") return final({ ...baseEvidence, uploadId: "upload-1", authoritative: true });
      if (env.MINI_PROGRAM_STAGE === "readReview") return final({ ...baseEvidence, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1", reviewStatus: "approved", authoritative: true });
      return final({ ...baseEvidence, ...evidence, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1", releaseId: "release-1", liveId: "live-1", liveStatus: "live", authoritative: true });
    },
  });
  await assert.rejects(adapter.upload({ manifest, app, evidence: baseEvidence }), /idempotency/i);
  const uploaded = await adapter.upload({ manifest, app, evidence: baseEvidence, idempotencyKey: "stable-id" });
  const reviewed = await adapter.submitReview({ manifest, app, evidence: uploaded, idempotencyKey: "stable-id" });
  const released = await adapter.release({ manifest, app, evidence: reviewed, idempotencyKey: "stable-id" });
  assert.deepEqual(stages, ["upload", "readUpload", "submitReview", "readReview", "release", "readLive"]);
  assert.equal(released.liveId, "live-1");
});

test("readLive rejects request echoes and closes the complete upload-review-release identity", async () => {
  const adapter = createWechatReleaseAdapter({
    command: ["fake"], credentialsPath: "/private/credentials", reviewConfigurationPath: "/private/review",
    runCommand: async () => final({ ...baseEvidence, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "wrong-review", releaseId: "release-1", liveId: "live-1", liveStatus: "live", authoritative: true }),
  });
  await assert.rejects(adapter.readLive({
    manifest, app, evidence: { ...baseEvidence, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1", releaseId: "release-1" },
  }), (error) => error.failureClassification === "validation" && /reviewId/i.test(error.message));
});

test("release capability requires authoritative approval for the exact review lineage", async () => {
  let called = false;
  const adapter = createWechatReleaseAdapter({
    command: ["fake"], credentialsPath: "/private/credentials", reviewConfigurationPath: "/private/review",
    runCommand: async () => { called = true; return final(baseEvidence); },
  });
  const evidence = { ...baseEvidence, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1" };
  await assert.rejects(adapter.release({ manifest, app, evidence: { ...evidence, reviewStatus: "in_review", authoritative: true }, idempotencyKey: "stable-id" }), /approved/i);
  await assert.rejects(adapter.release({ manifest, app, evidence: { ...evidence, reviewStatus: "approved", authoritative: false }, idempotencyKey: "stable-id" }), /authoritative/i);
  assert.equal(called, false);
});

test("an unknown mutation timeout invokes authoritative lookup", async () => {
  const stages = [];
  const adapter = createWechatReleaseAdapter({
    command: ["fake"], credentialsPath: "/private/credentials", reviewConfigurationPath: "/private/review",
    runCommand: async (_file, _args, { env }) => {
      stages.push(env.MINI_PROGRAM_STAGE);
      if (env.MINI_PROGRAM_STAGE === "upload") {
        const error = new Error("mini-program command timed out");
        error.code = "COMMAND_TIMEOUT";
        error.failureClassification = "release_infrastructure";
        throw error;
      }
      return final({ ...baseEvidence, uploadId: "upload-1", authoritative: true });
    },
  });
  const result = await adapter.upload({ manifest, app, evidence: baseEvidence, idempotencyKey: "stable-id" });
  assert.deepEqual(stages, ["upload", "readUpload"]);
  assert.equal(result.uploadId, "upload-1");
});

test("mutation nonzero exit and missing final JSON are unknown until authoritative lookup", async () => {
  for (const unknown of [
    { stdout: "", stderr: "child exited after request", exitCode: 2 },
    { stdout: "connection closed without evidence\n", stderr: "", exitCode: 0 },
  ]) {
    const stages = [];
    const adapter = createWechatReleaseAdapter({
      command: ["fake"], credentialsPath: "/private/credentials", reviewConfigurationPath: "/private/review",
      runCommand: async (_file, _args, { env }) => {
        stages.push(env.MINI_PROGRAM_STAGE);
        return env.MINI_PROGRAM_STAGE === "upload"
          ? unknown
          : final({ ...baseEvidence, uploadId: "upload-1", authoritative: true });
      },
    });
    const result = await adapter.upload({ manifest, app, evidence: baseEvidence, idempotencyKey: "stable-id" });
    assert.deepEqual(stages, ["upload", "readUpload"]);
    assert.equal(result.uploadId, "upload-1");
  }
});

test("upload and review lookup evidence must be authoritative and close the known lineage", async () => {
  for (const [stage, evidence, output] of [
    ["readUpload", baseEvidence, { ...baseEvidence, uploadId: "upload-1", authoritative: false }],
    ["readReview", { ...baseEvidence, uploadId: "upload-1", reviewSubmissionId: "submission-1" }, { ...baseEvidence, uploadId: "upload-1", reviewSubmissionId: "wrong", reviewId: "review-1", reviewStatus: "approved", authoritative: true }],
  ]) {
    const adapter = createWechatReleaseAdapter({
      command: ["fake"], credentialsPath: "/private/credentials", reviewConfigurationPath: "/private/review",
      runCommand: async () => final(output),
    });
    await assert.rejects(adapter[stage]({ manifest, app, evidence }), (error) => error.failureClassification === "validation");
  }
});

test("authoritative lookup can prove an unknown mutation absent without inventing lineage", async () => {
  for (const stage of ["readUpload", "readReview", "readLive"]) {
    const adapter = createWechatReleaseAdapter({
      command: ["fake"], credentialsPath: "/private/credentials", reviewConfigurationPath: "/private/review",
      runCommand: async () => final({ ...baseEvidence, status: "absent", authoritative: true }),
    });
    const result = await adapter[stage]({ manifest, app, evidence: baseEvidence });
    assert.equal(result.status, "absent");
    assert.equal(result.authoritative, true);
  }
});

test("nonzero exits, malformed final JSON, typed child failures, and oversized output fail closed", async () => {
  async function failure(result) {
    const adapter = createWechatReleaseAdapter({ command: ["fake"], credentialsPath: "/p", reviewConfigurationPath: "/r", repoPath: "/repo", artifactRoot: "/artifacts", productionApiAllowlist: ["https://api.example/v1"], runCommand: async () => result });
    return adapter.test({ manifest, app, evidence: baseEvidence });
  }
  await assert.rejects(failure({ stdout: JSON.stringify(baseEvidence), stderr: "failed", exitCode: 9 }), (error) => error.failureClassification === "release_infrastructure");
  await assert.rejects(failure({ stdout: "not-json\n", stderr: "", exitCode: 0 }), (error) => error.failureClassification === "validation");
  await assert.rejects(failure(final({ ok: false, error: { classification: "product_rework", deterministic: true, message: "review rejected" } })), (error) => error.failureClassification === "product_rework" && error.deterministic === true);
  await assert.rejects(failure({ stdout: `${"x".repeat(70_000)}\n${JSON.stringify(baseEvidence)}\n`, stderr: "", exitCode: 0 }), /bounded|large/i);
});

test("command completion requires an explicit finite integer zero exit code", async () => {
  for (const completion of [undefined, {}, { stdout: JSON.stringify(baseEvidence), stderr: "" }, { stdout: JSON.stringify(baseEvidence), exitCode: Number.NaN }, { stdout: JSON.stringify(baseEvidence), code: 0.5 }]) {
    const adapter = createWechatReleaseAdapter({
      command: ["fake"], credentialsPath: "/private/wechat.private.json", reviewConfigurationPath: "/private/review.private.json",
      repoPath: "/repo", artifactRoot: "/owned", productionApiAllowlist: ["https://api.365life.example/v1"],
      runCommand: async () => completion,
    });
    await assert.rejects(adapter.test({ manifest, app, evidence: baseEvidence }), /exit code|completion|unsuccessfully/i);
  }
});

test("all surfaced failures redact URL credentials, headers, JWTs, private keys, controls, and oversized text", async () => {
  const secrets = [
    "https://alice:password@example.com/path",
    "Authorization: Bearer top.secret.value",
    "Cookie: session=supersecret",
    "abcdefgh.ijklmnop.qrstuvwx",
    "-----BEGIN PRIVATE KEY----- abc -----END PRIVATE KEY-----",
    "bad\u0000control",
    "x".repeat(500),
  ];
  for (const secret of secrets) {
    const adapter = createWechatReleaseAdapter({
      command: ["fake"], credentialsPath: "/p", reviewConfigurationPath: "/r",
      repoPath: "/repo", artifactRoot: "/artifacts", productionApiAllowlist: ["https://api.example/v1"],
      runCommand: async () => { const error = new Error(secret); error.failureClassification = "external_unknown"; throw error; },
    });
    await assert.rejects(adapter.test({ manifest, app, evidence: baseEvidence }), (error) => {
      assert.equal(error.message.includes(secret), false);
      assert.equal(/[\u0000-\u001f\u007f]/u.test(error.message), false);
      assert.ok(error.message.length <= 240);
      return true;
    });
  }
});

test("the default command boundary terminates the detached process group on timeout and AbortSignal", async (t) => {
  const roots = [];
  t.after(async () => {
    for (const pid of roots) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
  });
  async function exercise(kind) {
    const pidFile = path.join(os.tmpdir(), `wechat-command-${kind}-${process.pid}-${Date.now()}.txt`);
    const controller = new AbortController();
    const source = `const fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)`;
    const pending = runCommandBoundary(process.execPath, ["-e", source, pidFile], { timeout: kind === "timeout" ? 80 : 5_000, signal: controller.signal, env: { PATH: process.env.PATH ?? "" } });
    while (true) {
      try { roots.push(Number(await readFile(pidFile, "utf8"))); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
    }
    if (kind === "abort") controller.abort(new Error("fence lost"));
    await assert.rejects(pending, (error) => error.code === (kind === "timeout" ? "COMMAND_TIMEOUT" : "COMMAND_ABORTED"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.throws(() => process.kill(-roots.at(-1), 0), /ESRCH/);
  }
  await exercise("timeout");
  await exercise("abort");
});

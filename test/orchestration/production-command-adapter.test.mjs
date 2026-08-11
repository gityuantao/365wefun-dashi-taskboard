import assert from "node:assert/strict";
import test from "node:test";

import { createReleaseAdapter } from "../../orchestration/release/production-command-adapter.mjs";

const SHA = "1111111111111111111111111111111111111111";
const manifest = {
  versionId: "v1.0.3",
  candidateCommit: SHA,
  checksum: "manifest-abc",
  artifactIdentity: { digest: "sha256:artifact", object: "candidate.tgz" },
};

function runtime(overrides = {}) {
  return {
    productionReleaseCommand: ["node", "scripts/deploy-production-candidate.mjs"],
    productionReleaseTimeoutMs: 1234,
    productionConfigPath: "/private/production-release.json",
    ...overrides,
  };
}

test("production command adapter passes exact frozen identity and parses only final JSON", async () => {
  const calls = [];
  const adapter = createReleaseAdapter({
    runtime: runtime(), projectRoot: "/repo",
    runCommand: async (file, args, options) => {
      calls.push({ file, args, options });
      const mode = options.env.PRODUCTION_RELEASE_MODE;
      if (mode === "regression") return { stdout: `progress\n${JSON.stringify({ passed: true, command: "pnpm test" })}\n`, stderr: "" };
      if (mode === "artifact") return { stdout: `ignored\n${JSON.stringify({ digest: "sha256:artifact", object: "candidate.tgz" })}\n`, stderr: "" };
      if (mode === "preflight") return { stdout: `${JSON.stringify({ ok: true })}\n`, stderr: "" };
      if (mode === "upload") return { stdout: `${JSON.stringify({ object: "candidate.tgz", etag: "etag-1", externalRequestId: "request-1" })}\n`, stderr: "" };
      if (mode === "switch") return { stdout: `${JSON.stringify({ url: "https://app.example.com", productionReleaseId: "release-1" })}\n`, stderr: "" };
      if (mode === "health") return { stdout: `${JSON.stringify({ ok: true, status: 200 })}\n`, stderr: "" };
      return { stdout: `${JSON.stringify({ confirmed: true, published: true, status: "published", authoritative: true, candidateCommit: SHA, artifactIdentity: manifest.artifactIdentity, externalRequestId: "request-1", productionReleaseId: "release-1", healthStatus: "healthy", evidence: { stateFile: "/releases/release-1/state.json" } })}\n`, stderr: "" };
    },
  });

  assert.deepEqual(await adapter.collectRegressionEvidence(manifest), { passed: true, command: "pnpm test" });
  assert.deepEqual(await adapter.identifyArtifact(manifest), manifest.artifactIdentity);
  const deployment = await adapter.release({ manifest, platform: "web", idempotencyKey: "idem-1" });
  const observed = await adapter.readback({ manifest, platform: "web", deployment, idempotencyKey: "idem-1" });
  assert.equal(observed.candidateCommit, SHA);
  assert.deepEqual(new Set(calls.map((call) => call.options.env.PRODUCTION_RELEASE_MODE)), new Set(["regression", "artifact", "preflight", "upload", "switch", "health", "readback"]));
  for (const { options } of calls) {
    assert.equal(options.cwd, "/repo");
    assert.equal(options.timeout, 1234);
    assert.equal(options.env.PRODUCTION_CANDIDATE_COMMIT, SHA);
    assert.equal(options.env.PRODUCTION_MANIFEST_CHECKSUM, "manifest-abc");
    assert.equal(options.env.PRODUCTION_VERSION_ID, "v1.0.3");
    assert.equal(options.env.PRODUCTION_CONFIG_PATH, "/private/production-release.json");
    assert.equal(options.env.PARENT_SECRET, undefined);
    assert.deepEqual(Object.keys(options.env).sort(), [
      "LANG", "PATH", "PRODUCTION_ARTIFACT_IDENTITY", "PRODUCTION_CONFIG_PATH",
      "PRODUCTION_EXTERNAL_REQUEST_ID", "PRODUCTION_IDEMPOTENCY_KEY",
      "PRODUCTION_MANIFEST_CHECKSUM", "PRODUCTION_PLATFORM", "PRODUCTION_READBACK_LOCATOR",
      "PRODUCTION_RELEASE_ID", "PRODUCTION_RELEASE_MODE", "PRODUCTION_VERSION_ID",
      "PRODUCTION_CANDIDATE_COMMIT",
    ].sort());
  }
});

test("Candidate evidence collection works before the Manifest checksum and artifact exist", async () => {
  const environments = [];
  const adapter = createReleaseAdapter({
    runtime: runtime(), projectRoot: "/repo",
    runCommand: async (_file, _args, options) => {
      environments.push(options.env);
      return options.env.PRODUCTION_RELEASE_MODE === "regression"
        ? { stdout: '{"passed":true,"command":"pnpm test"}\n' }
        : { stdout: `{"digest":"git:${SHA}","candidateCommit":"${SHA}"}\n` };
    },
  });
  const candidate = { versionId: "v1.0.3", versionBranch: "version/v1.0.3", candidateCommit: SHA };
  assert.equal((await adapter.collectRegressionEvidence(candidate)).passed, true);
  assert.deepEqual(await adapter.identifyArtifact(candidate), { digest: `git:${SHA}`, candidateCommit: SHA });
  assert.equal(environments[0].PRODUCTION_MANIFEST_CHECKSUM, "");
  assert.equal(environments[0].PRODUCTION_ARTIFACT_IDENTITY, "null");
});

test("production command adapter rejects malformed output, nonzero exits, timeout, and abort without leaking secrets", async () => {
  const cases = [
    [async () => ({ stdout: "not-json\n", stderr: "" }), /final JSON evidence/],
    [async () => { const error = new Error("token=super-secret failed"); error.code = 2; error.stderr = "Authorization: Bearer abc.def.ghi"; throw error; }, /\[REDACTED\]/],
    [async () => { const error = new Error("timed out secret=raw"); error.killed = true; throw error; }, /timed out/],
    [async () => { const error = new Error("aborted password=hunter2"); error.name = "AbortError"; throw error; }, /aborted/],
    [async () => { throw new Error("Cookie: sid=raw-cookie https://user:pass@example.com PRIVATE KEY api_key=raw-key"); }, /\[REDACTED\]/],
  ];
  for (const [runCommand, expected] of cases) {
    const adapter = createReleaseAdapter({ runtime: runtime(), projectRoot: "/repo", runCommand });
    await assert.rejects(adapter.collectRegressionEvidence(manifest), (error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /super-secret|abc\.def\.ghi|raw|hunter2|user:pass/);
      return true;
    });
  }
});

test("production command adapter requires explicit production-only runtime", () => {
  assert.throws(() => createReleaseAdapter({ runtime: {}, projectRoot: "/repo" }), /productionReleaseCommand/);
  assert.throws(() => createReleaseAdapter({ runtime: runtime({ productionConfigPath: "" }), projectRoot: "/repo" }), /productionConfigPath/);
});

test("production command adapter forwards AbortSignal to the real child boundary", async () => {
  const controller = new AbortController();
  const adapter = createReleaseAdapter({
    runtime: runtime(), projectRoot: "/repo",
    runCommand: async (_file, _args, options) => {
      assert.equal(options.signal, controller.signal);
      return { stdout: '{"passed":true}\n' };
    },
  });
  await adapter.collectRegressionEvidence(manifest, { signal: controller.signal });
});

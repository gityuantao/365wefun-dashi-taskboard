import assert from "node:assert/strict";
import test from "node:test";
import { confirmPublishedCandidate } from "../../orchestration/application/release-commands.mjs";
import { createWebAdapter } from "../../orchestration/release/adapters/web.mjs";

const MANIFEST = {
  versionId: "version-1",
  candidateCommit: "1111111111111111111111111111111111111111",
  artifactIdentity: {
    digest: "sha256:artifact-v1",
    object: "releases/version-1/sha256:artifact-v1",
  },
  taskIds: ["task-a"],
  createdAt: "2026-08-04T00:06:00.000Z",
  checksum: "abc123",
};

test("web adapter preflights, uploads, switches entry, and verifies health", async () => {
  const calls = [];
  const deployer = {
    preflight: async ({ manifest }) => {
      calls.push(["preflight", manifest.versionId]);
      return { ok: true };
    },
    upload: async ({ versionId, digest }) => {
      calls.push(["upload", versionId, digest]);
      return { object: `releases/${versionId}/${digest}/index.html` };
    },
    switchEntry: async ({ versionId }) => {
      calls.push(["switch", versionId]);
      return { url: "https://e365.example.com" };
    },
    healthCheck: async ({ url }) => {
      calls.push(["health", url]);
      return { ok: true, status: 200 };
    },
  };
  const adapter = createWebAdapter({ deployer });
  const result = await adapter.release({ manifest: MANIFEST });
  assert.equal(result.url, "https://e365.example.com");
  assert.equal(result.digest, "abc123");
  assert.ok(calls.some(([kind]) => kind === "preflight"));
  assert.ok(calls.some(([kind]) => kind === "upload"));
  assert.ok(calls.some(([kind]) => kind === "switch"));
  assert.ok(calls.some(([kind]) => kind === "health"));
});

test("web adapter fails when health check does not pass", async () => {
  const deployer = {
    preflight: async () => ({ ok: true }),
    upload: async () => ({ object: "x" }),
    switchEntry: async () => ({ url: "https://e365.example.com" }),
    healthCheck: async () => ({ ok: false, status: 503 }),
  };
  const adapter = createWebAdapter({ deployer });
  await assert.rejects(
    adapter.release({ manifest: MANIFEST }),
    /health check failed/i,
  );
});

test("web adapter collects evidence for the release", async () => {
  const deployer = {
    preflight: async () => ({ ok: true }),
    upload: async () => ({ object: "releases/v1/abc/index.html", etag: "etag-1" }),
    switchEntry: async () => ({ url: "https://e365.example.com" }),
    healthCheck: async () => ({ ok: true, status: 200 }),
  };
  const adapter = createWebAdapter({ deployer });
  const result = await adapter.release({ manifest: MANIFEST });
  assert.equal(result.evidence.object, "releases/v1/abc/index.html");
  assert.equal(result.evidence.url, "https://e365.example.com");
  assert.equal(typeof result.evidence.collectedAt, "string");
});

test("web adapter requires a configured deployer", async () => {
  const adapter = createWebAdapter({});
  await assert.rejects(
    adapter.release({ manifest: MANIFEST }),
    /deployer not configured/i,
  );
});

test("web adapter reads Candidate identity from persisted deployment state", async () => {
  let publishedState = null;
  const deployer = {
    upload: async ({ versionId, candidateCommit, artifactIdentity }) => ({
      object: `releases/${versionId}/${artifactIdentity.digest}/index.html`,
      candidateCommit,
      artifactIdentity,
    }),
    switchEntry: async ({ candidateCommit, artifactIdentity }) => {
      publishedState = {
        confirmed: true,
        published: true,
        candidateCommit,
        artifactIdentity: structuredClone(artifactIdentity),
        url: "https://e365.example.com",
      };
      return { url: publishedState.url };
    },
    healthCheck: async () => ({ ok: true, status: 200 }),
    readback: async () => structuredClone(publishedState),
  };
  const adapter = createWebAdapter({ deployer });
  const deployment = await adapter.release({ manifest: MANIFEST });
  const publication = await confirmPublishedCandidate({ adapter, manifest: MANIFEST, deployment });

  assert.equal(publication.candidateCommit, MANIFEST.candidateCommit);
  assert.deepEqual(publication.artifactIdentity, MANIFEST.artifactIdentity);
});

test("web adapter readback fails closed when deployment state is absent or incomplete", async () => {
  const missing = createWebAdapter({ deployer: {} });
  await assert.rejects(
    missing.readback({ manifest: MANIFEST, deployment: { url: "https://e365.example.com" } }),
    /readback.*not configured/i,
  );

  const incomplete = createWebAdapter({
    deployer: { readback: async () => ({ published: true }) },
  });
  await assert.rejects(
    incomplete.readback({ manifest: MANIFEST, deployment: { url: "https://e365.example.com" } }),
    /readback.*incomplete/i,
  );
});

test("web adapter never echoes requested Candidate over mismatched deployment state", async () => {
  const adapter = createWebAdapter({
    deployer: {
      readback: async () => ({
        confirmed: true,
        published: true,
        candidateCommit: "2222222222222222222222222222222222222222",
        artifactIdentity: { digest: "sha256:other" },
      }),
    },
  });
  const observed = await adapter.readback({ manifest: MANIFEST, deployment: null });
  assert.equal(observed.candidateCommit, "2222222222222222222222222222222222222222");
  await assert.rejects(
    confirmPublishedCandidate({ adapter, manifest: MANIFEST }),
    /exact frozen Candidate/i,
  );
});

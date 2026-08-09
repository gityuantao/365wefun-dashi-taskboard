import assert from "node:assert/strict";
import test from "node:test";
import { coordinateVersionRelease } from "../../orchestration/application/release-commands.mjs";

const NOW = "2026-08-04T00:08:00.000Z";

test("coordinator integrates task PRs, freezes one Candidate, publishes it, then records cleanup", async () => {
  const calls = [];
  const candidates = [
    {
      merged: true,
      versionBranch: "version/version-1",
      taskHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      candidateCommit: "1111111111111111111111111111111111111111",
    },
    {
      merged: true,
      versionBranch: "version/version-1",
      taskHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      candidateCommit: "2222222222222222222222222222222222222222",
    },
  ];
  let frozenManifest;

  const result = await coordinateVersionRelease({
    versionId: "version-1",
    versionBranch: "version/version-1",
    taskIds: ["task-a", "task-b"],
    now: NOW,
    integrateTaskPr: async ({ taskId, taskBranch }) => {
      calls.push(`merge:${taskId}:${taskBranch}`);
      return candidates.shift();
    },
    collectRegressionEvidence: async ({ candidateCommit }) => {
      calls.push(`regression:${candidateCommit}`);
      return { passed: true, command: "node --test", collectedAt: NOW };
    },
    identifyArtifact: async ({ candidateCommit }) => {
      calls.push(`artifact:${candidateCommit}`);
      return { digest: `sha256:${candidateCommit}`, object: `releases/${candidateCommit}` };
    },
    freezeCandidate: async (candidate) => {
      calls.push(`freeze:${candidate.candidateCommit}`);
      frozenManifest = { ...candidate, checksum: "manifest-checksum" };
      return { status: "frozen", manifest: frozenManifest };
    },
    verifyCandidate: async ({ manifest }) => {
      calls.push(`verify:${manifest.candidateCommit}`);
      return { verified: true };
    },
    publishCandidate: async ({ manifest }) => {
      calls.push(`publish:${manifest.candidateCommit}`);
      return {
        status: "succeeded",
        publication: { candidateCommit: manifest.candidateCommit, confirmed: true },
      };
    },
    cleanupTask: async ({ taskId, branch, candidateCommit }) => {
      calls.push(`cleanup:${taskId}:${candidateCommit}`);
      return {
        taskId,
        branch,
        pullRequestClosed: true,
        worktreeRemoved: true,
        localBranchRemoved: true,
        remoteBranchRemoved: true,
      };
    },
  });

  assert.equal(result.status, "succeeded");
  assert.equal(frozenManifest.candidateCommit, "2222222222222222222222222222222222222222");
  assert.deepEqual(frozenManifest.taskPrHeads, [
    {
      taskId: "task-a",
      branch: "task/task-a",
      headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    {
      taskId: "task-b",
      branch: "task/task-b",
      headCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  ]);
  assert.equal(result.cleanupResult.candidateCommit, frozenManifest.candidateCommit);
  assert.equal(result.cleanupResult.tasks.length, 2);
  assert.ok(calls.indexOf("publish:2222222222222222222222222222222222222222")
    < calls.indexOf("cleanup:task-a:2222222222222222222222222222222222222222"));
});

test("coordinator preserves PRs and refs when publication is not confirmed", async () => {
  const calls = [];
  const result = await coordinateVersionRelease({
    versionId: "version-1",
    versionBranch: "version/version-1",
    taskIds: ["task-a"],
    now: NOW,
    integrateTaskPr: async () => ({
      merged: true,
      versionBranch: "version/version-1",
      taskHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      candidateCommit: "1111111111111111111111111111111111111111",
    }),
    collectRegressionEvidence: async () => ({ passed: true, command: "node --test" }),
    identifyArtifact: async () => ({ digest: "sha256:artifact-v1" }),
    freezeCandidate: async (candidate) => ({
      status: "frozen",
      manifest: { ...candidate, checksum: "manifest-checksum" },
    }),
    verifyCandidate: async () => ({ verified: true }),
    publishCandidate: async () => ({ status: "failed", error: "remote readback missing" }),
    cleanupTask: async () => calls.push("cleanup"),
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /readback/i);
  assert.deepEqual(calls, []);
  assert.equal(result.cleanupResult, undefined);
});

test("coordinator stops before freezing or cleanup when task integration fails", async () => {
  const calls = [];
  const result = await coordinateVersionRelease({
    versionId: "version-1",
    versionBranch: "version/version-1",
    taskIds: ["task-a"],
    now: NOW,
    integrateTaskPr: async () => ({ merged: false, conflict: true, error: "conflict" }),
    collectRegressionEvidence: async () => calls.push("regression"),
    identifyArtifact: async () => calls.push("artifact"),
    freezeCandidate: async () => calls.push("freeze"),
    verifyCandidate: async () => calls.push("verify"),
    publishCandidate: async () => calls.push("publish"),
    cleanupTask: async () => calls.push("cleanup"),
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /integrat/i);
  assert.deepEqual(calls, []);
});

test("coordinator does not publish or cleanup an unverified frozen Candidate", async () => {
  const calls = [];
  const manifest = {
    versionId: "version-1",
    versionBranch: "version/version-1",
    candidateCommit: "1111111111111111111111111111111111111111",
    taskIds: ["task-a"],
    taskPrHeads: [{
      taskId: "task-a",
      branch: "task/task-a",
      headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }],
  };
  const result = await coordinateVersionRelease({
    versionId: "version-1",
    versionBranch: manifest.versionBranch,
    taskIds: manifest.taskIds,
    now: NOW,
    existingManifest: manifest,
    verifyCandidate: async () => ({ verified: false, error: "task PR head is not integrated" }),
    publishCandidate: async () => calls.push("publish"),
    cleanupTask: async () => calls.push("cleanup"),
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /not integrated/i);
  assert.deepEqual(calls, []);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import {
  coordinateVersionRelease,
  loadCleanupAttempts,
  recordCleanupAttempt,
} from "../../orchestration/application/release-commands.mjs";
import { coordinateReleaseSnapshot } from "../../orchestration/application/release-coordinator.mjs";

const NOW = "2026-08-04T00:08:00.000Z";

test("coordinator integrates task PRs, freezes one Candidate, publishes it, then records cleanup", async () => {
  const calls = [];
  const candidates = [
    {
      merged: true,
      versionBranch: "version/version-1",
      taskHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      candidateCommit: "1111111111111111111111111111111111111111",
      headRefName: "task/task-a",
      prNumber: 41,
      repository: "owner/repo",
    },
    {
      merged: true,
      versionBranch: "version/version-1",
      taskHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      candidateCommit: "2222222222222222222222222222222222222222",
      headRefName: "task/task-b",
      prNumber: 42,
      repository: "owner/repo",
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
    persistCandidate: async ({ candidateCommit }) => {
      calls.push(`persist:${candidateCommit}`);
      return {
        persisted: true,
        candidateRef: `refs/heads/release-candidate/version-1/${candidateCommit}`,
      };
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
  assert.equal(
    frozenManifest.candidateRef,
    "refs/heads/release-candidate/version-1/2222222222222222222222222222222222222222",
  );
  assert.deepEqual(frozenManifest.taskPrHeads, [
    {
      taskId: "task-a",
      branch: "task/task-a",
      headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      prNumber: 41,
      repository: "owner/repo",
    },
    {
      taskId: "task-b",
      branch: "task/task-b",
      headCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      prNumber: 42,
      repository: "owner/repo",
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
      headRefName: "task/task-a",
      prNumber: 42,
      repository: "owner/repo",
    }),
    collectRegressionEvidence: async () => ({ passed: true, command: "node --test" }),
    identifyArtifact: async () => ({ digest: "sha256:artifact-v1" }),
    persistCandidate: async ({ candidateCommit }) => ({
      persisted: true,
      candidateRef: `refs/heads/release-candidate/version-1/${candidateCommit}`,
    }),
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

test("iOS-only authoritative publication allows outer cleanup", async () => {
  const cleaned = [];
  const manifest = {
    versionId: "version-1",
    versionBranch: "version/v1.2.3",
    candidateCommit: "1111111111111111111111111111111111111111",
    taskIds: ["task-a"],
    taskPrHeads: [{ taskId: "task-a", branch: "task/task-a" }],
  };
  const result = await coordinateVersionRelease({
    versionId: manifest.versionId,
    versionBranch: manifest.versionBranch,
    taskIds: manifest.taskIds,
    existingManifest: manifest,
    now: NOW,
    verifyCandidate: async () => ({ verified: true }),
    publishCandidate: async () => ({
      status: "succeeded",
      publication: {
        kind: "ios_aggregate",
        status: "live",
        confirmed: true,
        published: true,
        candidateCommit: manifest.candidateCommit,
        cleanupToken: "ios:manifest-checksum:live-id",
      },
    }),
    cleanupTask: async ({ taskId }) => {
      cleaned.push(taskId);
      return { taskId };
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.publication.kind, "ios_aggregate");
  assert.equal(result.cleanupResult.status, "completed");
  assert.deepEqual(cleaned, ["task-a"]);
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
    persistCandidate: async () => calls.push("persist"),
    freezeCandidate: async () => calls.push("freeze"),
    verifyCandidate: async () => calls.push("verify"),
    publishCandidate: async () => calls.push("publish"),
    cleanupTask: async () => calls.push("cleanup"),
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /integrat/i);
  assert.deepEqual(calls, []);
});

test("coordinator does not freeze when remote PR heads changed before Candidate persistence", async () => {
  const calls = [];
  const result = await coordinateVersionRelease({
    versionId: "version-1",
    versionBranch: "version/version-1",
    taskIds: ["task-a"],
    now: NOW,
    integrateTaskPr: async () => ({
      merged: true,
      taskHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      candidateCommit: "1111111111111111111111111111111111111111",
      headRefName: "actual-remote-branch",
      prNumber: 42,
      repository: "owner/repo",
    }),
    collectRegressionEvidence: async () => ({ passed: true, command: "node --test" }),
    identifyArtifact: async () => ({ digest: "sha256:artifact-v1" }),
    persistCandidate: async () => ({ persisted: false, error: "GitHub PR 42 head changed" }),
    freezeCandidate: async () => calls.push("freeze"),
    verifyCandidate: async () => calls.push("verify"),
    publishCandidate: async () => calls.push("publish"),
    cleanupTask: async () => calls.push("cleanup"),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stage, "candidate_persistence");
  assert.match(result.error, /head changed/i);
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

test("cleanup persists each ordered attempt and safely resumes without repeating successes", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const manifest = {
    versionId: "version-1",
    versionBranch: "version/version-1",
    candidateCommit: "1111111111111111111111111111111111111111",
    candidateRef: "refs/heads/release-candidate/version-1/1111111111111111111111111111111111111111",
    taskIds: ["task-a"],
    taskPrHeads: [{
      taskId: "task-a",
      branch: "actual-remote-branch",
      headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      prNumber: 42,
      repository: "owner/repo",
    }],
  };
  const calls = [];
  let remoteAttempts = 0;
  const cleanupOperations = [
    {
      name: "close_pull_request",
      run: async () => {
        calls.push("close_pull_request");
        return { closed: true };
      },
    },
    {
      name: "delete_remote_branch",
      run: async () => {
        calls.push("delete_remote_branch");
        remoteAttempts += 1;
        if (remoteAttempts === 1) throw new Error("remote delete failed");
        return { deleted: true };
      },
    },
    {
      name: "remove_local_evidence",
      run: async () => {
        calls.push("remove_local_evidence");
        return { removed: true };
      },
    },
  ];
  const common = {
    versionId: "version-1",
    versionBranch: manifest.versionBranch,
    taskIds: manifest.taskIds,
    now: NOW,
    existingManifest: manifest,
    verifyCandidate: async () => ({ verified: true }),
    publishCandidate: async () => ({
      status: "succeeded",
      publication: { candidateCommit: manifest.candidateCommit },
    }),
    cleanupOperations,
    loadCleanupAttempts: (query) => loadCleanupAttempts({ db: harness.db, ...query }),
    recordCleanupAttempt: (attempt) => recordCleanupAttempt({ db: harness.db, ...attempt }),
  };

  const first = await coordinateVersionRelease(common);
  assert.equal(first.cleanupResult.status, "partial");
  assert.deepEqual(calls, ["close_pull_request", "delete_remote_branch"]);
  let persisted = await loadCleanupAttempts({
    db: harness.db,
    versionId: "version-1",
    candidateCommit: manifest.candidateCommit,
    taskId: "task-a",
  });
  assert.deepEqual(
    persisted.map(({ step, status }) => [step, status]),
    [["close_pull_request", "succeeded"], ["delete_remote_branch", "failed"]],
  );

  const second = await coordinateVersionRelease({ ...common, now: "2026-08-04T00:09:00.000Z" });
  assert.equal(second.cleanupResult.status, "completed");
  assert.deepEqual(calls, [
    "close_pull_request",
    "delete_remote_branch",
    "delete_remote_branch",
    "remove_local_evidence",
  ]);
  persisted = await loadCleanupAttempts({
    db: harness.db,
    versionId: "version-1",
    candidateCommit: manifest.candidateCommit,
    taskId: "task-a",
  });
  assert.deepEqual(
    persisted.map(({ step, status }) => [step, status]),
    [
      ["close_pull_request", "succeeded"],
      ["delete_remote_branch", "failed"],
      ["delete_remote_branch", "succeeded"],
      ["remove_local_evidence", "succeeded"],
    ],
  );
});

test("release snapshot wiring passes frozen platform and App identity into the persistent coordinator", async () => {
  const manifest = {
    versionId: "version-1",
    versionBranch: "version/v1.2.3",
    candidateCommit: "1111111111111111111111111111111111111111",
    checksum: "manifest-checksum-v1",
    taskIds: ["task-a"],
    taskPrHeads: [{ taskId: "task-a", branch: "task/task-a" }],
    productionTargetPlan: {
      schemaVersion: 1,
      taskPlatforms: [{ taskId: "task-a", platforms: ["web", "ios"] }],
      platforms: { web: true, api: false, ios: true },
      iosApps: [{
        id: "au", name: "Overseas", appStoreAppId: "0000000001", scheme: "E365AU",
        bundleId: "online.365english.app", marketingVersion: "1.2.3",
        testScheme: "E365AUTests", testTarget: "E365AUTests",
        buildNumberSource: "app-store-connect", releaseMode: "automatic",
        reviewConfigurationRef: "app-store-review/au", testFlightGroup: "Internal Testing",
      }],
    },
  };
  const iosAdapter = { release() {}, readback() {} };
  const releaseLease = { holder: "release-worker-1", durationMs: 60_000 };
  let received;
  const result = await coordinateReleaseSnapshot({
    productionReadiness: { ready: true, error: null },
    snapshot: { id: "version-1", name: "v1.2.3", status: "releasing" },
    now: NOW,
    db: {},
    adapter: { release() {}, readback() {} },
    iosAdapter,
    apps: [{
      id: "au",
      name: "Overseas",
      enabled: true,
      scheme: "E365AU",
      testScheme: "E365AUTests",
      testTarget: "E365AUTests",
      bundleId: "online.365english.app",
      testFlightGroup: "Internal Testing",
      buildNumberSource: "app-store-connect",
      appStoreAppId: "0000000001",
      releaseMode: "automatic",
      reviewConfigurationRef: "app-store-review/au",
    }],
    releaseLease,
    client: {},
    runtime: { repoPath: "/repo", worktreesRoot: "/worktrees" },
    repository: "owner/repo",
    releaseGitOps: { verifyCandidate: async () => ({ verified: true }) },
    services: {
      loadManifest: async () => manifest,
      loadAggregate: async () => ({ state: "releasing", version: 2 }),
      loadAllTaskSnapshots: async () => [{ id: "task-a", platforms: ["web", "ios"] }],
      handleConfirmRelease: async (options) => {
        received = options;
        return { status: "waiting_external", targets: [] };
      },
      loadCleanupAttempts: async () => [],
      recordCleanupAttempt: async () => {},
      closeTaskPullRequest: async () => {},
      deleteRemoteTaskBranch: async () => {},
      removeTaskWorktree: async () => {},
    },
  });

  assert.equal(result.status, "waiting_external");
  assert.equal(received.platforms, undefined);
  assert.equal(received.apps, undefined);
  assert.equal(received.targetPlanValidated, true);
  assert.equal(received.iosAdapter, iosAdapter);
  assert.equal(received.lease, releaseLease);
});

test("production coordinator wiring blocks stale local and advanced remote PR heads", async () => {
  const sideEffects = [];
  const services = {
    loadManifest: async () => null,
    loadAggregate: async () => ({ state: "active", version: 1 }),
    checkVersionGate: async () => ({ pass: true, reasons: [], taskIds: ["task-a"] }),
    loadAllTaskSnapshots: async () => [{
      id: "task-a", targetVersion: "version-1", platforms: ["web"],
    }],
    loadTaskPullRequest: async () => "https://github.com/owner/repo/pull/42",
    freezeManifest: async () => sideEffects.push("freeze"),
    handleConfirmRelease: async () => sideEffects.push("deploy"),
    loadCleanupAttempts: async () => [],
    recordCleanupAttempt: async () => sideEffects.push("record-cleanup"),
    closeTaskPullRequest: async () => sideEffects.push("close-pr"),
    deleteRemoteTaskBranch: async () => sideEffects.push("delete-remote"),
    removeTaskWorktree: async () => sideEffects.push("remove-local"),
  };
  const base = {
    snapshot: { id: "version-1", name: "version-1", status: "releasing" },
    now: NOW,
    db: {},
    adapter: {
      release: async () => sideEffects.push("adapter-release"),
      readback: async () => ({ confirmed: true }),
      collectRegressionEvidence: async () => ({ passed: true }),
      identifyArtifact: async () => ({ digest: "sha256:artifact" }),
    },
    client: {},
    runtime: { repoPath: "/repo", worktreesRoot: "/worktrees" },
    repository: "owner/repo",
    services,
    log: () => {},
  };

  const localStale = await coordinateReleaseSnapshot({
    productionReadiness: { ready: true, error: null },
    ...base,
    releaseGitOps: {
      integrateTaskPr: async () => ({ merged: false, error: "fetched PR head is stale" }),
    },
  });
  assert.equal(localStale.status, "failed");
  assert.deepEqual(sideEffects, []);

  const remoteAdvanced = await coordinateReleaseSnapshot({
    productionReadiness: { ready: true, error: null },
    ...base,
    releaseGitOps: {
      integrateTaskPr: async () => ({
        merged: true,
        taskHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        candidateCommit: "1111111111111111111111111111111111111111",
        headRefName: "actual-remote-branch",
        prNumber: 42,
        repository: "owner/repo",
      }),
      persistCandidate: async () => ({ persisted: false, error: "GitHub PR 42 head changed" }),
    },
  });
  assert.equal(remoteAdvanced.status, "failed");
  assert.equal(remoteAdvanced.stage, "candidate_persistence");
  assert.deepEqual(sideEffects, []);
});

test("Candidate mini-program scope supplements missing task scope before freeze", async () => {
  let frozen;
  const result = await coordinateReleaseSnapshot({
    productionReadiness: { ready: true }, snapshot: { id: "version-1", name: "version-1", status: "releasing" }, now: NOW,
    db: {}, adapter: {
      collectRegressionEvidence: async () => ({ passed: true }), identifyArtifact: async () => ({ digest: "sha256:artifact" }),
    }, runtime: { repoPath: "/repo", worktreesRoot: "/worktrees", iosApps: [] }, repository: "owner/repo",
    releaseGitOps: {
      integrateTaskPr: async () => ({
        merged: true, taskHead: "a".repeat(40), candidateCommit: "b".repeat(40), candidateBaseCommit: "c".repeat(40),
        headRefName: "task/task-mp", prNumber: 42, repository: "owner/repo",
      }),
      persistCandidate: async () => ({ persisted: true, candidateRef: "refs/heads/release-candidate/version-1/b" }),
      verifyCandidate: async () => ({ verified: true }),
    },
    services: {
      loadManifest: async () => null, loadAggregate: async () => ({ state: "active", version: 1 }),
      loadAllTaskSnapshots: async () => [{ id: "task-mp", targetVersion: "version-1", platforms: [] }],
      loadTaskPullRequest: async () => "https://github.com/owner/repo/pull/42",
      classifyCandidateChanges: () => ({ baseCommit: "c".repeat(40), candidateCommit: "b".repeat(40), mappingVersion: 1, changedPaths: ["apps/mp/pages/index.ts"], platforms: ["mini_program"], unsupported: [] }),
      checkVersionGate: async () => ({ pass: true, reasons: [], releaseEligibility: {
        ready: true, gaps: [], taskIds: ["task-mp"], taskPlatforms: [{ taskId: "task-mp", platforms: ["mini_program"], source: "candidate_scope", evidenceId: null, commitSha: null, acceptedCommitSha: null }],
        candidateScope: { platforms: ["mini_program"] }, plannedTargets: ["mini_program"],
      } }),
      freezeManifest: async (input) => { frozen = input; return { status: "frozen", manifest: { ...input, taskPrHeads: input.taskPrHeads } }; },
      handleConfirmRelease: async () => ({ status: "succeeded", publication: { candidateCommit: "b".repeat(40) } }),
      loadCleanupAttempts: async () => [], recordCleanupAttempt: async () => ({}), closeTaskPullRequest: async () => ({}), deleteRemoteTaskBranch: async () => ({}), removeTaskWorktree: async () => ({}),
    },
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(frozen.productionTargetPlan.taskPlatforms, [{ taskId: "task-mp", platforms: ["mini_program"] }]);
  assert.equal(frozen.candidateScope.platforms[0], "mini_program");
});

test("unsupported production scope is rejected before every mutating release effect", async () => {
  const mutations = [];
  const result = await coordinateReleaseSnapshot({
    productionReadiness: { ready: true, error: null },
    snapshot: { id: "version-1", name: "version-1", status: "releasing" },
    now: NOW,
    db: {},
    adapter: {
      collectRegressionEvidence: async () => mutations.push("regression"),
      identifyArtifact: async () => mutations.push("artifact"),
    },
    runtime: { repoPath: "/repo", worktreesRoot: "/worktrees", iosApps: [] },
    repository: "owner/repo",
    releaseGitOps: {
      integrateTaskPr: async () => mutations.push("integrate"),
      persistCandidate: async () => mutations.push("persist"),
      verifyCandidate: async () => mutations.push("verify"),
    },
    services: {
      loadManifest: async () => null,
      loadAggregate: async () => ({ state: "active", version: 1 }),
      loadAllTaskSnapshots: async () => [{
        id: "task-a", targetVersion: "version-1", platforms: ["visionos"],
      }],
      checkVersionGate: async () => ({ pass: true, reasons: [], taskIds: ["task-a"] }),
      freezeManifest: async () => mutations.push("freeze"),
      handleConfirmRelease: async () => mutations.push("publish"),
    },
  });

  assert.equal(result.status, "rejected");
  assert.match(result.error, /visionos|support/i);
  assert.deepEqual(mutations, []);
});

test("missing task scope reaches Candidate integration before a Candidate-derived gate closes it", async () => {
  const mutations = [];
  const result = await coordinateReleaseSnapshot({
    productionReadiness: { ready: true, error: null },
    snapshot: { id: "version-1", name: "version-1", status: "releasing" },
    now: NOW,
    db: {},
    adapter: {
      collectRegressionEvidence: async () => mutations.push("regression"),
      identifyArtifact: async () => mutations.push("artifact"),
    },
    runtime: { repoPath: "/repo", worktreesRoot: "/worktrees" },
    repository: "owner/repo",
    releaseGitOps: { integrateTaskPr: async () => mutations.push("integrate") },
    services: {
      loadManifest: async () => null,
      loadAggregate: async () => ({ state: "active", version: 1 }),
      loadAllTaskSnapshots: async () => [],
      checkVersionGate: async () => ({ pass: true, reasons: [], taskIds: [] }),
    },
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /regression|scope|non-empty/i);
  assert.deepEqual(mutations, ["regression"]);
});

test("retry rejects frozen production target plan drift before verification or publication", async () => {
  const mutations = [];
  const manifest = {
    versionId: "version-1",
    versionBranch: "version/v1.2.3",
    candidateCommit: "1111111111111111111111111111111111111111",
    checksum: "manifest-checksum-v1",
    taskIds: ["task-a"],
    taskPrHeads: [{ taskId: "task-a", branch: "task/task-a" }],
    productionTargetPlan: {
      schemaVersion: 1,
      taskPlatforms: [{ taskId: "task-a", platforms: ["ios"] }],
      platforms: { web: false, api: false, ios: true },
      iosApps: [{
        id: "au", name: "Overseas", scheme: "E365AU", testScheme: "E365AUTests",
        testTarget: "E365AUTests", bundleId: "online.365english.app",
        testFlightGroup: "Internal Testing", buildNumberSource: "app-store-connect",
        appStoreAppId: "0000000001", releaseMode: "automatic",
        reviewConfigurationRef: "app-store-review/au", marketingVersion: "1.2.3",
      }],
    },
  };
  const result = await coordinateReleaseSnapshot({
    productionReadiness: { ready: true, error: null },
    snapshot: { id: "version-1", name: "v1.2.3", status: "releasing" },
    now: NOW,
    db: {},
    adapter: {},
    iosAdapter: {},
    apps: [{
      ...manifest.productionTargetPlan.iosApps[0],
      enabled: false,
    }],
    runtime: { repoPath: "/repo", worktreesRoot: "/worktrees" },
    repository: "owner/repo",
    releaseGitOps: { verifyCandidate: async () => mutations.push("verify") },
    services: {
      loadManifest: async () => manifest,
      loadAggregate: async () => ({ state: "releasing", version: 2 }),
      loadAllTaskSnapshots: async () => [{ id: "task-a", platforms: ["ios"] }],
      handleConfirmRelease: async () => mutations.push("publish"),
    },
  });

  assert.equal(result.status, "rejected");
  assert.match(result.error, /target plan|drift|registry/i);
  assert.deepEqual(mutations, []);
});

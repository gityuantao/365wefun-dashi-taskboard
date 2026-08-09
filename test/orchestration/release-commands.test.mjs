import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { createDomainEvent } from "../../orchestration/domain/events.mjs";
import { appendCommandResult } from "../../orchestration/persistence/d1-event-store.mjs";
import { freezeManifest } from "../../orchestration/release/version-aggregator.mjs";
import { saveSnapshot } from "../../orchestration/clickup/snapshot.mjs";
import { handleConfirmRelease } from "../../orchestration/application/release-commands.mjs";

const NOW = "2026-08-04T00:07:00.000Z";
const CANDIDATE_COMMIT = "1111111111111111111111111111111111111111";
const ARTIFACT_IDENTITY = {
  digest: "sha256:artifact-v1",
  object: "releases/version-1/sha256:artifact-v1",
};

async function seedVersion(harness, versionId) {
  const event = await createDomainEvent({
    id: `rel-seed-${versionId}-1`,
    sequence: 1,
    aggregateType: "version",
    aggregateId: versionId,
    aggregateVersion: 1,
    type: "version.activated",
    commandId: `rel-seed-cmd-${versionId}-1`,
    actorId: "system",
    occurredAt: NOW,
    data: { from: "planning", to: "active" },
    previousHash: null,
  });
  await appendCommandResult(harness.db, {
    command: parseCommandEnvelope({
      id: `rel-seed-cmd-${versionId}-1`,
      type: "activate_version",
      aggregateType: "version",
      aggregateId: versionId,
      expectedVersion: 1,
      actorId: "system",
      issuedAt: NOW,
      reason: "seed",
      parameters: {},
    }),
    events: [event],
    projection: { state: "active", snapshot: { kind: "version" } },
  });
}

async function seedTaskToRelease(harness, taskId) {
  for (let index = 0; index < 7; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "acceptance_passed", "start_test",
      "test_passed"][index];
    await dispatchCommand({
      db: harness.db,
      command: parseCommandEnvelope({
        id: `rel-task-${taskId}-${index}`,
        type,
        aggregateType: "task",
        aggregateId: taskId,
        expectedVersion: index + 1,
        actorId: "system",
        issuedAt: NOW,
        reason: "seed",
        parameters: {},
      }),
      now: NOW,
    });
  }
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: taskId,
      listId: "901616314492",
      status: "ready_for_release",
      managed: true,
      operationRequest: null,
      operationRequestId: null,
      targetVersion: "version-1",
      assignee: null,
      updatedAt: NOW,
      fieldsHash: "hash",
    },
    readAt: NOW,
  });
}

async function prepareVersion(harness) {
  await seedVersion(harness, "version-1");
  await seedTaskToRelease(harness, "task-a");
  await freezeManifest({
    db: harness.db,
    versionId: "version-1",
    now: NOW,
    versionBranch: "version/version-1",
    candidateCommit: CANDIDATE_COMMIT,
    candidateRef: `refs/heads/release-candidate/version-1/${CANDIDATE_COMMIT}`,
    taskPrHeads: [{
      taskId: "task-a",
      branch: "task/task-a",
      headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      prNumber: 42,
      repository: "owner/repo",
    }],
    artifactIdentity: ARTIFACT_IDENTITY,
    regressionEvidence: {
      passed: true,
      command: "node --test test/orchestration/*.test.mjs",
      collectedAt: NOW,
    },
  });
}

test("confirm release publishes the version and its tasks", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await prepareVersion(harness);
  const adapter = {
    release: async ({ manifest }) => ({ url: "https://releases.example.com/v1" }),
    readback: async () => ({
      confirmed: true,
      published: true,
      candidateCommit: CANDIDATE_COMMIT,
      artifactIdentity: ARTIFACT_IDENTITY,
    }),
  };
  const result = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-1",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    now: NOW,
    adapter,
  });
  assert.equal(result.status, "succeeded");
  const version = await loadAggregate(harness.db, "version", "version-1");
  assert.equal(version.state, "published");
  const task = await loadAggregate(harness.db, "task", "task-a");
  assert.equal(task.state, "published");
  assert.equal(result.publication.candidateCommit, CANDIDATE_COMMIT);
});

test("confirm release rejects missing or placeholder deployers before state changes", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await prepareVersion(harness);

  for (const adapter of [null, { placeholder: true, release: async () => ({}) }]) {
    const result = await handleConfirmRelease({
      db: harness.db,
      versionId: "version-1",
      actorId: "release-manager",
      actorRoles: ["release_manager"],
      now: NOW,
      adapter,
    });
    assert.equal(result.status, "rejected");
    assert.match(result.error, /deployer|adapter/i);
    const version = await loadAggregate(harness.db, "version", "version-1");
    assert.equal(version.state, "active");
  }
});

test("confirm release fails without exact remote Candidate readback and preserves tasks", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await prepareVersion(harness);

  const result = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-1",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    now: NOW,
    adapter: {
      release: async () => ({ url: "https://releases.example.com/v1" }),
      readback: async () => ({
        confirmed: true,
        published: true,
        candidateCommit: "2222222222222222222222222222222222222222",
        artifactIdentity: ARTIFACT_IDENTITY,
      }),
    },
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /Candidate readback/i);
  assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "release_failed");
  assert.equal((await loadAggregate(harness.db, "task", "task-a")).state, "ready_for_release");
});

test("confirm release rejects missing manifests", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedVersion(harness, "version-2");
  const result = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-2",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    now: NOW,
    adapter: { release: async () => ({}) },
  });
  assert.equal(result.status, "rejected");
  assert.match(result.error, /manifest/i);
});

test("confirm release failure leaves tasks ready for release", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await prepareVersion(harness);
  const adapter = {
    release: async () => { throw new Error("deploy failed"); },
    readback: async () => {
      throw new Error("readback must not run after deployment failure");
    },
  };
  const result = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-1",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    now: NOW,
    adapter,
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /deploy failed/);
  const version = await loadAggregate(harness.db, "version", "version-1");
  assert.equal(version.state, "release_failed");
  const task = await loadAggregate(harness.db, "task", "task-a");
  assert.equal(task.state, "ready_for_release");
});

test("release_failed retries the existing immutable Candidate without recomputing it", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await prepareVersion(harness);
  const frozenBefore = await harness.db
    .prepare("SELECT manifest, created_at FROM release_manifests WHERE version_id = ?")
    .bind("version-1")
    .first();

  const first = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-1",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    now: NOW,
    adapter: {
      release: async () => { throw new Error("first deployment failed"); },
      readback: async () => { throw new Error("unreachable"); },
    },
  });
  assert.equal(first.status, "failed");
  assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "release_failed");

  let deployedManifest;
  const second = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-1",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    now: "2026-08-04T00:08:00.000Z",
    adapter: {
      release: async ({ manifest }) => {
        deployedManifest = manifest;
        return { url: "https://releases.example.com/v1" };
      },
      readback: async () => ({
        confirmed: true,
        published: true,
        candidateCommit: CANDIDATE_COMMIT,
        artifactIdentity: ARTIFACT_IDENTITY,
      }),
    },
  });

  assert.equal(second.status, "succeeded");
  assert.equal(deployedManifest.candidateCommit, CANDIDATE_COMMIT);
  assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "published");
  const frozenAfter = await harness.db
    .prepare("SELECT manifest, created_at FROM release_manifests WHERE version_id = ?")
    .bind("version-1")
    .first();
  assert.deepEqual(frozenAfter, frozenBefore);
});

test("partial task publication retries remaining tasks before publishing the version", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedVersion(harness, "version-1");
  await seedTaskToRelease(harness, "task-a");
  await seedTaskToRelease(harness, "task-b");
  await freezeManifest({
    db: harness.db,
    versionId: "version-1",
    now: NOW,
    versionBranch: "version/version-1",
    candidateCommit: CANDIDATE_COMMIT,
    candidateRef: `refs/heads/release-candidate/version-1/${CANDIDATE_COMMIT}`,
    taskPrHeads: [
      {
        taskId: "task-a",
        branch: "remote-task-a",
        headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        prNumber: 41,
        repository: "owner/repo",
      },
      {
        taskId: "task-b",
        branch: "remote-task-b",
        headCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        prNumber: 42,
        repository: "owner/repo",
      },
    ],
    artifactIdentity: ARTIFACT_IDENTITY,
    regressionEvidence: { passed: true, command: "node --test", collectedAt: NOW },
  });
  const adapter = {
    release: async () => ({ url: "https://releases.example.com/v1" }),
    readback: async () => ({
      confirmed: true,
      published: true,
      candidateCommit: CANDIDATE_COMMIT,
      artifactIdentity: ARTIFACT_IDENTITY,
    }),
  };
  let failTaskB = true;
  const published = [];
  const dispatch = async (input) => {
    if (input.command.type === "publish_task") {
      published.push(input.command.aggregateId);
      if (input.command.aggregateId === "task-b" && failTaskB) {
        throw new Error("task-b publish failed");
      }
    }
    return dispatchCommand(input);
  };

  const first = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-1",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    now: NOW,
    adapter,
    dispatch,
  });
  assert.equal(first.status, "failed");
  assert.match(first.error, /task-b publish failed/);
  assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "release_failed");
  assert.equal((await loadAggregate(harness.db, "task", "task-a")).state, "published");
  assert.equal((await loadAggregate(harness.db, "task", "task-b")).state, "ready_for_release");

  failTaskB = false;
  const second = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-1",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    now: "2026-08-04T00:09:00.000Z",
    adapter,
    dispatch,
  });
  assert.equal(second.status, "succeeded");
  assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "published");
  assert.equal((await loadAggregate(harness.db, "task", "task-b")).state, "published");
  assert.equal(published.filter((taskId) => taskId === "task-a").length, 1);
  assert.equal(published.filter((taskId) => taskId === "task-b").length, 2);
});

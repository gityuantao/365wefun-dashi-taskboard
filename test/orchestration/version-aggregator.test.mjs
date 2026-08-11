import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { createDomainEvent } from "../../orchestration/domain/events.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { appendCommandResult } from "../../orchestration/persistence/d1-event-store.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { saveSnapshot } from "../../orchestration/clickup/snapshot.mjs";
import {
  checkVersionGate,
  freezeManifest,
  loadManifest,
  validateFrozenManifest,
} from "../../orchestration/release/version-aggregator.mjs";
import { assertProductionTargetPlanMatches } from "../../orchestration/release/production-target-plan.mjs";

const NOW = "2026-08-04T00:06:00.000Z";
const CANDIDATE = {
  versionBranch: "version/version-1",
  candidateCommit: "1111111111111111111111111111111111111111",
  candidateRef: "refs/heads/release-candidate/version-1/1111111111111111111111111111111111111111",
  taskPrHeads: [
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
  ],
  artifactIdentity: {
    digest: "sha256:artifact-v1",
    object: "releases/version-1/sha256:artifact-v1",
  },
  regressionEvidence: {
    passed: true,
    command: "node --test test/orchestration/*.test.mjs",
    collectedAt: NOW,
  },
  productionTargetPlan: {
    schemaVersion: 1,
    taskPlatforms: [
      { taskId: "task-a", platforms: ["web"] },
      { taskId: "task-b", platforms: ["web"] },
    ],
    platforms: { web: true, api: false, ios: false },
    iosApps: [],
  },
};

async function seedActiveVersion(harness, versionId = "version-1") {
  const event = await createDomainEvent({
    id: `seed-${versionId}`,
    sequence: 1,
    aggregateType: "version",
    aggregateId: versionId,
    aggregateVersion: 1,
    type: "version.activated",
    commandId: `seed-cmd-${versionId}`,
    actorId: "system",
    occurredAt: NOW,
    data: { from: "planning", to: "active" },
    previousHash: null,
  });
  await appendCommandResult(harness.db, {
    command: parseCommandEnvelope({
      id: `seed-cmd-${versionId}`,
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

async function seedTaskSnapshot(harness, taskId, status, targetVersion) {
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: taskId,
      listId: "901616314492",
      status,
      managed: true,
      operationRequest: null,
      operationRequestId: null,
      targetVersion,
      assignee: null,
      updatedAt: NOW,
      fieldsHash: "hash",
    },
    readAt: NOW,
  });
}

test("version gate fails with no tasks", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  const gate = await checkVersionGate({ db: harness.db, versionId: "version-1" });
  assert.equal(gate.pass, false);
  assert.ok(gate.reasons.some((reason) => reason.includes("no tasks")));
});

test("version gate fails when a task is not ready for release", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  await seedTaskSnapshot(harness, "task-a", "developing", "version-1");
  await seedTaskSnapshot(harness, "task-b", "ready_for_release", "version-1");
  const gate = await checkVersionGate({ db: harness.db, versionId: "version-1" });
  assert.equal(gate.pass, false);
  assert.ok(gate.reasons.some((reason) => reason.includes("task-a")));
});

test("version gate fails when a task is blocked", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  await seedTaskSnapshot(harness, "task-a", "ready_for_release", "version-1");
  await harness.db
    .prepare(
      `INSERT INTO blockers (id, object_type, object_id, type, reason, status, created_at)
       VALUES (?, 'task', ?, 'rework_budget', ?, 'open', ?)`,
    )
    .bind("block-task-a", "task-a", "exhausted", NOW)
    .run();
  const gate = await checkVersionGate({ db: harness.db, versionId: "version-1" });
  assert.equal(gate.pass, false);
  assert.ok(gate.reasons.some((reason) => reason.includes("blocked")));
});

test("freezeManifest records the exact immutable Candidate without advancing version state", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  await seedTaskSnapshot(harness, "task-a", "ready_for_release", "version-1");
  await seedTaskSnapshot(harness, "task-b", "ready_for_release", "version-1");
  const result = await freezeManifest({
    db: harness.db,
    versionId: "version-1",
    now: NOW,
    ...CANDIDATE,
  });
  assert.equal(result.status, "frozen");
  assert.deepEqual(result.manifest.taskIds.sort(), ["task-a", "task-b"]);
  assert.equal(result.manifest.versionBranch, CANDIDATE.versionBranch);
  assert.equal(result.manifest.candidateCommit, CANDIDATE.candidateCommit);
  assert.equal(result.manifest.candidateRef, CANDIDATE.candidateRef);
  assert.deepEqual(result.manifest.taskPrHeads, CANDIDATE.taskPrHeads);
  assert.deepEqual(result.manifest.artifactIdentity, CANDIDATE.artifactIdentity);
  assert.deepEqual(result.manifest.regressionEvidence, CANDIDATE.regressionEvidence);
  assert.deepEqual(result.manifest.productionTargetPlan, CANDIDATE.productionTargetPlan);
  assert.equal(typeof result.manifest.checksum, "string");
  const tamperedPlan = structuredClone(result.manifest);
  tamperedPlan.productionTargetPlan.platforms.api = true;
  assert.ok(validateFrozenManifest(tamperedPlan).some((reason) => /checksum/i.test(reason)));
  const aggregate = await loadAggregate(harness.db, "version", "version-1");
  assert.equal(aggregate.state, "active");
  const stored = await loadManifest({ db: harness.db, versionId: "version-1" });
  assert.deepEqual(stored, result.manifest);

  const changedCandidate = await freezeManifest({
    db: harness.db,
    versionId: "version-1",
    now: "2026-08-04T00:10:00.000Z",
    ...CANDIDATE,
    candidateCommit: "2222222222222222222222222222222222222222",
  });
  assert.equal(changedCandidate.status, "already_frozen");
  assert.deepEqual(changedCandidate.manifest, result.manifest);
});

test("freezeManifest rejects Candidate metadata gaps", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  await seedTaskSnapshot(harness, "task-a", "ready_for_release", "version-1");

  const result = await freezeManifest({
    db: harness.db,
    versionId: "version-1",
    now: NOW,
    versionBranch: "version/version-1",
    candidateCommit: CANDIDATE.candidateCommit,
    taskPrHeads: [],
    artifactIdentity: CANDIDATE.artifactIdentity,
    regressionEvidence: { passed: false },
  });

  assert.equal(result.status, "rejected");
  assert.ok(result.reasons.some((reason) => /task PR heads/i.test(reason)));
  assert.ok(result.reasons.some((reason) => /regression evidence/i.test(reason)));
  assert.equal(await loadManifest({ db: harness.db, versionId: "version-1" }), null);
});

test("freezeManifest refuses when the gate fails", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  const result = await freezeManifest({ db: harness.db, versionId: "version-1", now: NOW });
  assert.equal(result.status, "rejected");
});

test("frozen target plan rejects additions, removals, reordering, and tuple drift", () => {
  const plan = {
    schemaVersion: 1,
    taskPlatforms: [{ taskId: "task-a", platforms: ["web", "ios"] }],
    platforms: { web: true, api: false, ios: true },
    iosApps: [
      { id: "au", appStoreAppId: "1" },
      { id: "cn", appStoreAppId: "2" },
    ],
  };
  const variants = [
    { ...structuredClone(plan), iosApps: [plan.iosApps[0]] },
    { ...structuredClone(plan), iosApps: [...plan.iosApps, { id: "nz", appStoreAppId: "3" }] },
    { ...structuredClone(plan), iosApps: [...plan.iosApps].reverse() },
    {
      ...structuredClone(plan),
      iosApps: [{ ...plan.iosApps[0], appStoreAppId: "changed" }, plan.iosApps[1]],
    },
  ];
  for (const variant of variants) {
    assert.throws(
      () => assertProductionTargetPlanMatches(plan, variant),
      /target plan.*drift/i,
    );
  }
});

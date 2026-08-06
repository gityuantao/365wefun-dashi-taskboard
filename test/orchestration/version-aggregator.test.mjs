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
} from "../../orchestration/release/version-aggregator.mjs";

const NOW = "2026-08-04T00:06:00.000Z";

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

test("freezeManifest freezes tasks without advancing the version state", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  await seedTaskSnapshot(harness, "task-a", "ready_for_release", "version-1");
  await seedTaskSnapshot(harness, "task-b", "ready_for_release", "version-1");
  const result = await freezeManifest({ db: harness.db, versionId: "version-1", now: NOW });
  assert.equal(result.status, "frozen");
  assert.deepEqual(result.manifest.taskIds.sort(), ["task-a", "task-b"]);
  assert.equal(typeof result.manifest.checksum, "string");
  const aggregate = await loadAggregate(harness.db, "version", "version-1");
  assert.equal(aggregate.state, "active");
  const stored = await loadManifest({ db: harness.db, versionId: "version-1" });
  assert.equal(stored.versionId, "version-1");
});

test("freezeManifest refuses when the gate fails", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  const result = await freezeManifest({ db: harness.db, versionId: "version-1", now: NOW });
  assert.equal(result.status, "rejected");
});

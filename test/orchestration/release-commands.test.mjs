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
  await freezeManifest({ db: harness.db, versionId: "version-1", now: NOW });
}

test("confirm release publishes the version and its tasks", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await prepareVersion(harness);
  const adapter = {
    release: async ({ manifest }) => ({ url: "https://releases.example.com/v1" }),
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
});

test("confirm release rejects missing manifests", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedVersion(harness, "version-2");
  await dispatchCommand({
    db: harness.db,
    command: parseCommandEnvelope({
      id: "rel-prepare-2",
      type: "prepare_release",
      aggregateType: "version",
      aggregateId: "version-2",
      expectedVersion: 2,
      actorId: "system",
      issuedAt: NOW,
      reason: "prepare",
      parameters: {},
    }),
    now: NOW,
  });
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

import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { createDomainEvent } from "../../orchestration/domain/events.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { appendCommandResult } from "../../orchestration/persistence/d1-event-store.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";

const NOW = "2026-08-04T00:00:05.000Z";

function command(id, type, aggregateType, aggregateId, expectedVersion, parameters = {}) {
  return parseCommandEnvelope({
    id,
    type,
    aggregateType,
    aggregateId,
    expectedVersion,
    actorId: "subject-1",
    issuedAt: NOW,
    reason: "test dispatch",
    parameters,
  });
}

async function dispatchTask(harness, id, type, version, parameters = {}) {
  const result = await dispatchCommand({
    db: harness.db,
    command: command(id, type, "task", "task-1", version, parameters),
    now: NOW,
  });
  return result;
}

async function seedVersion(harness, versionId, state, version) {
  const event = await createDomainEvent({
    id: `seed-${versionId}-${version}`,
    sequence: version,
    aggregateType: "version",
    aggregateId: versionId,
    aggregateVersion: version,
    type: "version.activated",
    commandId: `seed-cmd-${versionId}-${version}`,
    actorId: "subject-1",
    occurredAt: NOW,
    data: { from: "planning", to: state },
    previousHash: version === 1 ? null : "a".repeat(64),
  });
  await appendCommandResult(harness.db, {
    command: parseCommandEnvelope({
      id: `seed-cmd-${versionId}-${version}`,
      type: "activate_version",
      aggregateType: "version",
      aggregateId: versionId,
      expectedVersion: version,
      actorId: "subject-1",
      issuedAt: NOW,
      reason: "seed",
      parameters: {},
    }),
    events: [event],
    projection: { state, snapshot: null },
  });
}

test("task happy path dispatches every command with exact transitions", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const steps = [
    ["start_analysis", "analyzing", "task.analysis_started"],
    ["analysis_completed", "ready_for_development", "task.analysis_completed"],
    ["start_development", "developing", "task.development_started"],
    ["development_completed", "ready_for_test", "task.development_completed"],
    ["start_test", "testing", "task.test_started"],
    ["test_passed", "ready_for_acceptance", "task.test_passed"],
    ["start_acceptance", "accepting", "task.acceptance_started"],
    ["acceptance_passed", "ready_for_release", "task.acceptance_passed"],
  ];
  for (let index = 0; index < steps.length; index += 1) {
    const [type, expectedState, expectedEventType] = steps[index];
    const result = await dispatchTask(harness, `task-cmd-${index}`, type, index + 1);
    assert.equal(result.status, "succeeded");
    assert.equal(result.aggregateType, "task");
    assert.equal(result.version, index + 1);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, expectedEventType);
    const aggregate = await loadAggregate(harness.db, "task", "task-1");
    assert.equal(aggregate.version, index + 1);
    assert.equal(aggregate.state, expectedState);
  }
});

test("test failure requires evidence and returns to ready for development", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await dispatchTask(harness, "task-cmd-0", "start_analysis", 1);
  await dispatchTask(harness, "task-cmd-1", "analysis_completed", 2);
  await dispatchTask(harness, "task-cmd-2", "start_development", 3);
  await dispatchTask(harness, "task-cmd-3", "development_completed", 4);
  await dispatchTask(harness, "task-cmd-4", "start_test", 5);

  await assert.rejects(
    dispatchTask(harness, "task-cmd-5", "test_failed", 6),
    /EVIDENCE_REQUIRED/,
  );
  const failed = await dispatchTask(harness, "task-cmd-6", "test_failed", 6, {
    evidenceId: "ev-test-1",
  });
  assert.equal(failed.events[0].type, "task.test_failed");
  assert.equal(failed.events[0].data.from, "testing");
  assert.equal(failed.events[0].data.to, "ready_for_development");
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_development");
  assert.equal(aggregate.version, 6);
});

test("acceptance failure requires evidence and returns to ready for development", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 7; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "start_test", "test_passed", "start_acceptance"][index];
    await dispatchTask(harness, `task-cmd-${index}`, type, index + 1);
  }
  const failed = await dispatchTask(harness, "task-cmd-7", "acceptance_failed", 8, {
    evidenceId: "ev-accept-1",
  });
  assert.equal(failed.events[0].type, "task.acceptance_failed");
  assert.equal(failed.events[0].data.to, "ready_for_development");
});

test("task commands reject unsupported types and impossible jumps", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await assert.rejects(
    dispatchTask(harness, "task-cmd-x", "prepare_release", 1),
    /UNSUPPORTED_COMMAND/,
  );
  await assert.rejects(
    dispatchTask(harness, "task-cmd-0", "start_development", 1),
    /INVALID_TRANSITION/,
  );
});

test("version commands prepare, start, and succeed a release", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedVersion(harness, "version-1", "active", 1);

  const prepared = await dispatchCommand({
    db: harness.db,
    command: command("ver-cmd-1", "prepare_release", "version", "version-1", 2),
    now: NOW,
  });
  assert.equal(prepared.events[0].type, "version.release_prepared");
  assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "ready_for_release");

  const started = await dispatchCommand({
    db: harness.db,
    command: command("ver-cmd-2", "start_release", "version", "version-1", 3),
    now: NOW,
  });
  assert.equal(started.events[0].type, "version.release_started");
  assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "releasing");

  const succeeded = await dispatchCommand({
    db: harness.db,
    command: command("ver-cmd-3", "release_succeeded", "version", "version-1", 4),
    now: NOW,
  });
  assert.equal(succeeded.events[0].type, "version.published");
  assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "published");
});

test("version release failure requires evidence and leaves the version release_failed", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedVersion(harness, "version-2", "active", 1);
  await dispatchCommand({
    db: harness.db,
    command: command("ver-cmd-1", "prepare_release", "version", "version-2", 2),
    now: NOW,
  });
  await dispatchCommand({
    db: harness.db,
    command: command("ver-cmd-2", "start_release", "version", "version-2", 3),
    now: NOW,
  });
  await assert.rejects(
    dispatchCommand({
      db: harness.db,
      command: command("ver-cmd-3", "release_failed", "version", "version-2", 4),
      now: NOW,
    }),
    /EVIDENCE_REQUIRED/,
  );
  const failed = await dispatchCommand({
    db: harness.db,
    command: command("ver-cmd-4", "release_failed", "version", "version-2", 4, {
      evidenceId: "ev-release-1",
    }),
    now: NOW,
  });
  assert.equal(failed.events[0].type, "version.release_failed");
  const aggregate = await loadAggregate(harness.db, "version", "version-2");
  assert.equal(aggregate.state, "release_failed");
  assert.equal(aggregate.version, 4);
});

test("version commands reject impossible jumps", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedVersion(harness, "version-3", "active", 1);
  await assert.rejects(
    dispatchCommand({
      db: harness.db,
      command: command("ver-cmd-1", "start_release", "version", "version-3", 2),
      now: NOW,
    }),
    /INVALID_TRANSITION/,
  );
});

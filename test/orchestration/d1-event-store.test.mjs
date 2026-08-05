import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { createDomainEvent } from "../../orchestration/domain/events.mjs";
import {
  appendCommandResult,
  loadCommandResult,
} from "../../orchestration/persistence/d1-event-store.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";

function makeCommand(id, expectedVersion, type = "start_analysis") {
  return parseCommandEnvelope({
    id,
    type,
    aggregateType: "task",
    aggregateId: "task-1",
    expectedVersion,
    actorId: "subject-1",
    issuedAt: "2026-08-04T00:00:00.000Z",
    reason: "start analysis",
    parameters: {},
  });
}

async function makeEvent(command, version, previousHash, id) {
  return createDomainEvent({
    id: id ?? `evt-${command.id}-${version}`,
    sequence: version,
    aggregateType: "task",
    aggregateId: "task-1",
    aggregateVersion: version,
    type: "task.analysis_started",
    commandId: command.id,
    actorId: command.actorId,
    occurredAt: "2026-08-04T00:00:01.000Z",
    data: { from: "inbox", to: "analyzing" },
    previousHash,
  });
}

test("submitting the same command twice is idempotent", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const command = makeCommand("cmd-1", 1);
  const event = await makeEvent(command, 1, null);
  const projection = { state: "analyzing", snapshot: { from: "inbox" } };

  const first = await appendCommandResult(harness.db, {
    command,
    events: [event],
    projection,
  });
  const second = await appendCommandResult(harness.db, {
    command,
    events: [event],
    projection,
  });

  assert.deepEqual(second.result, first.result);
  assert.equal(second.commandId, "cmd-1");
  assert.equal(second.status, "succeeded");
  const commandRows = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM orchestration_commands")
    .first();
  const eventRows = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM orchestration_events")
    .first();
  assert.equal(commandRows.count, 1);
  assert.equal(eventRows.count, 1);
});

test("two commands expecting the same aggregate version conflict", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const firstCommand = makeCommand("cmd-2", 1);
  const firstEvent = await makeEvent(firstCommand, 1, null);
  await appendCommandResult(harness.db, {
    command: firstCommand,
    events: [firstEvent],
    projection: { state: "analyzing", snapshot: null },
  });

  const secondCommand = makeCommand("cmd-3", 1);
  const secondEvent = await makeEvent(secondCommand, 1, null);
  await assert.rejects(
    appendCommandResult(harness.db, {
      command: secondCommand,
      events: [secondEvent],
      projection: { state: "analyzing", snapshot: null },
    }),
    /VERSION_CONFLICT/,
  );
});

test("previous hash chain mismatch is rejected", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const firstCommand = makeCommand("cmd-4", 1);
  const firstEvent = await makeEvent(firstCommand, 1, null);
  await appendCommandResult(harness.db, {
    command: firstCommand,
    events: [firstEvent],
    projection: { state: "analyzing", snapshot: null },
  });

  const secondCommand = makeCommand("cmd-5", 2, "analysis_completed");
  const secondEvent = await makeEvent(secondCommand, 2, "f".repeat(64));
  await assert.rejects(
    appendCommandResult(harness.db, {
      command: secondCommand,
      events: [secondEvent],
      projection: { state: "ready_for_development", snapshot: null },
    }),
    /HASH_MISMATCH/,
  );
});

test("loadAggregate and loadCommandResult expose the stored projection", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  assert.deepEqual(await loadAggregate(harness.db, "task", "task-1"), {
    aggregateType: "task",
    aggregateId: "task-1",
    version: 0,
    state: null,
    snapshot: null,
  });
  assert.equal(await loadCommandResult(harness.db, "missing"), null);

  const command = makeCommand("cmd-6", 1);
  const event = await makeEvent(command, 1, null);
  await appendCommandResult(harness.db, {
    command,
    events: [event],
    projection: { state: "analyzing", snapshot: { from: "inbox" } },
  });

  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.version, 1);
  assert.equal(aggregate.state, "analyzing");
  assert.deepEqual(aggregate.snapshot, { from: "inbox" });

  const result = await loadCommandResult(harness.db, "cmd-6");
  assert.equal(result.status, "succeeded");
  assert.equal(result.result.version, 1);
  assert.equal(result.result.aggregateType, "task");
  assert.equal(result.result.events.length, 1);
});

test("appending an event chain advances aggregate versions and hashes", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const firstCommand = makeCommand("cmd-7", 1);
  const firstEvent = await makeEvent(firstCommand, 1, null);
  await appendCommandResult(harness.db, {
    command: firstCommand,
    events: [firstEvent],
    projection: { state: "analyzing", snapshot: null },
  });

  const secondCommand = makeCommand("cmd-8", 2, "analysis_completed");
  const secondEvent = await makeEvent(secondCommand, 2, firstEvent.hash);
  await appendCommandResult(harness.db, {
    command: secondCommand,
    events: [secondEvent],
    projection: { state: "ready_for_development", snapshot: null },
  });

  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.version, 2);
  assert.equal(aggregate.state, "ready_for_development");
  const rows = await harness.db
    .prepare(
      "SELECT aggregate_version, previous_hash FROM orchestration_events ORDER BY sequence",
    )
    .all();
  assert.deepEqual(
    rows.results.map(({ aggregate_version, previous_hash }) => ({
      version: aggregate_version,
      previous: previous_hash,
    })),
    [
      { version: 1, previous: null },
      { version: 2, previous: firstEvent.hash },
    ],
  );
});

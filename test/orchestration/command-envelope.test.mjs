import assert from "node:assert/strict";
import test from "node:test";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { createDomainEvent } from "../../orchestration/domain/events.mjs";

const VALID_COMMAND = {
  id: "cmd-1",
  type: "start_analysis",
  aggregateType: "task",
  aggregateId: "task-1",
  expectedVersion: 1,
  actorId: "subject-1",
  issuedAt: "2026-08-04T00:00:00.000Z",
  reason: "accepted scope",
  parameters: {},
};

test("command envelope accepts a valid strict command", () => {
  const parsed = parseCommandEnvelope(VALID_COMMAND);
  assert.deepEqual(parsed, VALID_COMMAND);
});

test("command rejects unknown fields and mutable names", () => {
  assert.throws(
    () => parseCommandEnvelope({
      ...VALID_COMMAND,
      statusName: "分析中",
    }),
    /UNKNOWN_FIELD/,
  );
});

test("command rejects invalid identifiers and versions", () => {
  assert.throws(
    () => parseCommandEnvelope({ ...VALID_COMMAND, id: "" }),
    /INVALID_FIELD/,
  );
  assert.throws(
    () => parseCommandEnvelope({ ...VALID_COMMAND, aggregateId: " " }),
    /INVALID_FIELD/,
  );
  for (const version of [0, -1, 1.5, "1", Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => parseCommandEnvelope({ ...VALID_COMMAND, expectedVersion: version }),
      /INVALID_FIELD/,
    );
  }
});

test("command rejects unknown aggregate types", () => {
  assert.throws(
    () => parseCommandEnvelope({ ...VALID_COMMAND, aggregateType: "project" }),
    /INVALID_FIELD/,
  );
});

test("command requires RFC3339 UTC issuedAt", () => {
  for (const issuedAt of ["2026-08-04", "not-a-date", "2026-08-04T00:00:00+08:00"]) {
    assert.throws(
      () => parseCommandEnvelope({ ...VALID_COMMAND, issuedAt }),
      /INVALID_FIELD/,
    );
  }
});

test("command parameters are bounded to 4 KiB and must be plain objects", () => {
  const oversized = {
    ...VALID_COMMAND,
    parameters: { blob: "x".repeat(4 * 1024 + 1) },
  };
  assert.throws(() => parseCommandEnvelope(oversized), /PARAMETERS_TOO_LARGE/);
  assert.throws(
    () => parseCommandEnvelope({ ...VALID_COMMAND, parameters: ["not", "an", "object"] }),
    /INVALID_FIELD/,
  );
});

test("domain event includes all contract fields and a 64-character hash", async () => {
  const event = await createDomainEvent({
    id: "evt-1",
    sequence: 1,
    aggregateType: "task",
    aggregateId: "task-1",
    aggregateVersion: 1,
    type: "task.analysis_started",
    commandId: "cmd-1",
    actorId: "subject-1",
    occurredAt: "2026-08-04T00:00:00.000Z",
    data: { from: "inbox", to: "analyzing" },
    previousHash: null,
  });
  assert.equal(typeof event.hash, "string");
  assert.match(event.hash, /^[0-9a-f]{64}$/);
  assert.equal(event.previousHash, null);
});

test("domain event hashing is deterministic and binds content and previous hash", async () => {
  const base = {
    id: "evt-2",
    sequence: 2,
    aggregateType: "task",
    aggregateId: "task-1",
    aggregateVersion: 2,
    type: "task.analysis_completed",
    commandId: "cmd-2",
    actorId: "subject-1",
    occurredAt: "2026-08-04T00:00:01.000Z",
    data: { from: "analyzing", to: "ready_for_development" },
  };
  const first = await createDomainEvent({ ...base, previousHash: "a".repeat(64) });
  const second = await createDomainEvent({ ...base, previousHash: "a".repeat(64) });
  assert.equal(first.hash, second.hash);

  const otherData = await createDomainEvent({
    ...base,
    previousHash: "a".repeat(64),
    data: { from: "analyzing", to: "ready_for_development", extra: true },
  });
  assert.notEqual(otherData.hash, first.hash);

  const otherPrevious = await createDomainEvent({
    ...base,
    previousHash: "b".repeat(64),
  });
  assert.notEqual(otherPrevious.hash, first.hash);
});

test("domain event rejects invalid shapes", async () => {
  await assert.rejects(
    createDomainEvent({
      id: "evt-3",
      sequence: 1,
      aggregateType: "task",
      aggregateId: "task-1",
      aggregateVersion: 0,
      type: "task.analysis_started",
      commandId: "cmd-1",
      actorId: "subject-1",
      occurredAt: "2026-08-04T00:00:00.000Z",
      data: {},
      previousHash: null,
    }),
    /INVALID_FIELD/,
  );
});

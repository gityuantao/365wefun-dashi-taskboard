import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";

const NOW = "2026-08-04T00:00:05.000Z";

function commandPayload(id, expectedVersion) {
  return {
    id,
    type: "start_analysis",
    aggregateType: "task",
    aggregateId: "task-api-1",
    expectedVersion,
    actorId: "subject-1",
    issuedAt: NOW,
    reason: "api test",
    parameters: {},
  };
}

test("orchestration diagnostic API is disabled by default", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const response = await harness.request("/api/orchestration/commands", {
    method: "POST",
    actorName: "owner",
    json: commandPayload("cmd-api-0", 1),
  });
  assert.equal(response.response.status, 404);
  assert.equal(response.body.error.code, "ORCHESTRATION_DISABLED");
});

test("enabled diagnostic API accepts commands idempotently", async (t) => {
  const harness = await createCloudWorkerHarness({
    bindings: {
      ORCHESTRATION_DIAGNOSTIC_ENABLED: "true",
      ORCHESTRATION_NOW: NOW,
    },
  });
  t.after(() => harness.dispose());

  const first = await harness.request("/api/orchestration/commands", {
    method: "POST",
    actorName: "owner",
    json: commandPayload("cmd-api-1", 1),
  });
  assert.equal(first.response.status, 202);
  assert.equal(first.body.commandId, "cmd-api-1");
  assert.equal(first.body.status, "succeeded");

  const duplicate = await harness.request("/api/orchestration/commands", {
    method: "POST",
    actorName: "owner",
    json: commandPayload("cmd-api-1", 1),
  });
  assert.equal(duplicate.response.status, 202);
  assert.deepEqual(duplicate.body, first.body);

  const commandRow = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM orchestration_commands")
    .first();
  const eventRow = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM orchestration_events")
    .first();
  assert.equal(commandRow.count, 1);
  assert.equal(eventRow.count, 1);
});

test("enabled diagnostic API rejects version conflicts and unknown fields", async (t) => {
  const harness = await createCloudWorkerHarness({
    bindings: {
      ORCHESTRATION_DIAGNOSTIC_ENABLED: "true",
      ORCHESTRATION_NOW: NOW,
    },
  });
  t.after(() => harness.dispose());

  const first = await harness.request("/api/orchestration/commands", {
    method: "POST",
    actorName: "owner",
    json: commandPayload("cmd-api-2", 1),
  });
  assert.equal(first.response.status, 202);

  const conflict = await harness.request("/api/orchestration/commands", {
    method: "POST",
    actorName: "owner",
    json: commandPayload("cmd-api-3", 1),
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, "VERSION_CONFLICT");

  const unknown = await harness.request("/api/orchestration/commands", {
    method: "POST",
    actorName: "owner",
    json: { ...commandPayload("cmd-api-4", 2), statusName: "分析中" },
  });
  assert.equal(unknown.response.status, 400);
  assert.equal(unknown.body.error.code, "UNKNOWN_FIELD");
});

test("enabled diagnostic API exposes stored command results", async (t) => {
  const harness = await createCloudWorkerHarness({
    bindings: {
      ORCHESTRATION_DIAGNOSTIC_ENABLED: "true",
      ORCHESTRATION_NOW: NOW,
    },
  });
  t.after(() => harness.dispose());

  await harness.request("/api/orchestration/commands", {
    method: "POST",
    actorName: "owner",
    json: commandPayload("cmd-api-5", 1),
  });
  const result = await harness.request("/api/orchestration/commands/cmd-api-5", {
    method: "GET",
    actorName: "owner",
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.commandId, "cmd-api-5");
  assert.equal(result.body.status, "succeeded");
  assert.equal(result.body.result.version, 1);

  const missing = await harness.request("/api/orchestration/commands/missing", {
    method: "GET",
    actorName: "owner",
  });
  assert.equal(missing.response.status, 404);
});

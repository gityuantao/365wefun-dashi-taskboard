import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";

test("orchestration schema creates the six core tables in order", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const names = await harness.db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'orchestration_%' ORDER BY name",
    )
    .all();
  assert.deepEqual(
    names.results.map(({ name }) => name),
    [
      "orchestration_aggregates",
      "orchestration_approvals",
      "orchestration_commands",
      "orchestration_events",
      "orchestration_external_refs",
      "orchestration_leases",
    ],
  );
});

test("orchestration migration preserves every table from 0001_initial.sql", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const names = await harness.db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'orchestration_%' ORDER BY name",
    )
    .all();
  const tables = names.results.map(({ name }) => name);
  for (const expected of [
    "projects",
    "tasks",
    "task_relations",
    "comments",
    "attachments",
    "workflow_workspaces",
    "global_revision",
  ]) {
    assert.ok(tables.includes(expected), `expected table ${expected} to be preserved`);
  }
});

test("orchestration schema enforces command idempotency and event version uniqueness", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const command = {
    id: "cmd-schema-1",
    type: "start_analysis",
    aggregate_type: "task",
    aggregate_id: "task-schema-1",
    expected_version: 1,
    actor_id: "subject-1",
    issued_at: "2026-08-04T00:00:00.000Z",
    reason: "schema test",
    parameters: "{}",
    status: "pending",
    created_at: "2026-08-04T00:00:00.000Z",
    updated_at: "2026-08-04T00:00:00.000Z",
  };
  await harness.db
    .prepare(
      `INSERT INTO orchestration_commands (
        id, type, aggregate_type, aggregate_id, expected_version, actor_id,
        issued_at, reason, parameters, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      command.id,
      command.type,
      command.aggregate_type,
      command.aggregate_id,
      command.expected_version,
      command.actor_id,
      command.issued_at,
      command.reason,
      command.parameters,
      command.status,
      command.created_at,
      command.updated_at,
    )
    .run();
  await assert.rejects(
    harness.db
      .prepare(
        `INSERT INTO orchestration_commands (
          id, type, aggregate_type, aggregate_id, expected_version, actor_id,
          issued_at, reason, parameters, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        command.id,
        command.type,
        command.aggregate_type,
        command.aggregate_id,
        command.expected_version,
        command.actor_id,
        command.issued_at,
        command.reason,
        command.parameters,
        command.status,
        command.created_at,
        command.updated_at,
      )
      .run(),
    /UNIQUE constraint failed/,
  );

  await harness.db
    .prepare(
      `INSERT INTO orchestration_events (
        id, sequence, aggregate_type, aggregate_id, aggregate_version, type,
        command_id, actor_id, occurred_at, data, previous_hash, hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "evt-schema-1",
      1,
      "task",
      "task-schema-1",
      1,
      "task.analysis_started",
      "cmd-schema-1",
      "subject-1",
      "2026-08-04T00:00:00.000Z",
      '{"from":"inbox","to":"analyzing"}',
      null,
      "a".repeat(64),
    )
    .run();
  await assert.rejects(
    harness.db
      .prepare(
        `INSERT INTO orchestration_events (
          id, sequence, aggregate_type, aggregate_id, aggregate_version, type,
          command_id, actor_id, occurred_at, data, previous_hash, hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "evt-schema-2",
        2,
        "task",
        "task-schema-1",
        1,
        "task.analysis_started",
        "cmd-schema-1",
        "subject-1",
        "2026-08-04T00:00:00.000Z",
        '{"from":"inbox","to":"analyzing"}',
        null,
        "b".repeat(64),
      )
      .run(),
    /UNIQUE constraint failed/,
  );
});

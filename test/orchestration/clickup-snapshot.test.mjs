import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { loadClickUpConfig } from "../../orchestration/clickup/config-registry.mjs";
import {
  compareSnapshots,
  loadLastConfirmed,
  normalizeTask,
  normalizeVersion,
  saveSnapshot,
} from "../../orchestration/clickup/snapshot.mjs";

const CONFIG = loadClickUpConfig({
  teamId: "90161712199",
  spaceId: "90167718544",
  lists: {
    task: { id: "901616282651", name: "任务" },
    version: { id: "901616282740", name: "版本" },
    taskSandbox: { id: "901616314492", name: "任务-Sandbox" },
    versionSandbox: { id: "901616314494", name: "版本-Sandbox" },
  },
  taskStatusMap: { 收件箱: "inbox", 验收中: "accepting", 待发布: "ready_for_release" },
  versionStatusMap: { 规划中: "planning", 发布中: "releasing" },
  fields: {
    task: {
      目标版本: { id: "field-version", type: "short_text" },
    },
    version: {
      发布阻塞: { id: "field-ver-block", type: "drop_down" },
    },
  },
});

function taskPayload(overrides = {}) {
  return {
    id: "task-1",
    name: "Sample task",
    status: { status: "收件箱" },
    custom_fields: [
      { id: "field-version", name: "目标版本", value: "version-9" },
    ],
    updated_at: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

test("normalizeTask extracts canonical state and key custom fields by id", () => {
  const snapshot = normalizeTask(taskPayload(), CONFIG);
  assert.equal(snapshot.id, "task-1");
  assert.equal(snapshot.status, "inbox");
  assert.equal(snapshot.targetVersion, "version-9");
  assert.equal(snapshot.updatedAt, "2026-08-04T00:00:00.000Z");
});

test("normalizeTask rejects unknown statuses and handles missing fields", () => {
  assert.throws(
    () => normalizeTask(taskPayload({ status: { status: "不存在" } }), CONFIG),
    /UNKNOWN_STATUS/,
  );
  const snapshot = normalizeTask(taskPayload({ custom_fields: [] }), CONFIG);
  assert.equal(snapshot.targetVersion, null);
});

test("normalizeTask treats ClickUp built-in to do as inbox", () => {
  const snapshot = normalizeTask(taskPayload({ status: { status: "to do" } }), CONFIG);
  assert.equal(snapshot.status, "inbox");
});

test("normalizeVersion maps the version list statuses", () => {
  const snapshot = normalizeVersion({
    id: "version-1",
    status: { status: "发布中" },
    custom_fields: [
      { id: "field-ver-block", name: "发布阻塞", value: "未阻塞" },
    ],
    updated_at: "2026-08-04T00:00:00.000Z",
  }, CONFIG);
  assert.equal(snapshot.status, "releasing");
  assert.equal(snapshot.blocked, false);
});

test("fields hash is deterministic and changes with content", () => {
  const first = normalizeTask(taskPayload(), CONFIG);
  const second = normalizeTask(taskPayload(), CONFIG);
  assert.equal(first.fieldsHash, second.fieldsHash);
  const changed = normalizeTask(
    taskPayload({ status: { status: "验收中" } }),
    CONFIG,
  );
  assert.notEqual(changed.fieldsHash, first.fieldsHash);
});

test("saveSnapshot and loadLastConfirmed round-trip through D1", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  assert.equal(await loadLastConfirmed(harness.db, "task", "task-1"), null);
  const snapshot = normalizeTask(taskPayload(), CONFIG);
  await saveSnapshot(harness.db, { type: "task", snapshot });
  const loaded = await loadLastConfirmed(harness.db, "task", "task-1");
  assert.equal(loaded.status, "inbox");
  assert.equal(loaded.fieldsHash, snapshot.fieldsHash);

  const updated = normalizeTask(
    taskPayload({ status: { status: "验收中" }, updated_at: "2026-08-04T00:00:01.000Z" }),
    CONFIG,
  );
  await saveSnapshot(harness.db, { type: "task", snapshot: updated });
  const reloaded = await loadLastConfirmed(harness.db, "task", "task-1");
  assert.equal(reloaded.status, "accepting");
});

test("compareSnapshots reports field-level changes", () => {
  const confirmed = normalizeTask(taskPayload(), CONFIG);
  assert.deepEqual(compareSnapshots(null, confirmed), [
    { field: "status", from: null, to: "inbox" },
    { field: "targetVersion", from: null, to: "version-9" },
    { field: "updatedAt", from: null, to: "2026-08-04T00:00:00.000Z" },
  ]);
  const moved = normalizeTask(taskPayload({ status: { status: "验收中" } }), CONFIG);
  assert.deepEqual(compareSnapshots(confirmed, moved), [
    { field: "status", from: "inbox", to: "accepting" },
  ]);
  assert.deepEqual(compareSnapshots(confirmed, confirmed), []);
});

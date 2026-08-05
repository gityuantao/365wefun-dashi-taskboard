import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { loadClickUpConfig } from "../../orchestration/clickup/config-registry.mjs";
import {
  confirmMutation,
  enqueueMutation,
  flushOutbox,
} from "../../orchestration/clickup/outbox.mjs";

const CONFIG = loadClickUpConfig({
  teamId: "90161712199",
  spaceId: "90167718544",
  lists: {
    task: { id: "901616282651", name: "任务" },
    version: { id: "901616282740", name: "版本" },
    taskSandbox: { id: "901616314492", name: "任务-Sandbox" },
    versionSandbox: { id: "901616314494", name: "版本-Sandbox" },
  },
  taskStatusMap: { 收件箱: "inbox" },
  versionStatusMap: { 规划中: "planning" },
  fields: {
    task: {
      自动化纳管: { id: "field-managed", type: "checkbox" },
      操作请求: { id: "field-request", type: "drop_down" },
    },
    version: {},
    taskSandbox: {},
    versionSandbox: {},
  },
});

const NOW = "2026-08-04T00:00:20.000Z";

function mutationBase(overrides = {}) {
  return {
    mutationId: "mut-1",
    objectType: "task",
    objectId: "task-1",
    field: "status",
    expectedBefore: "测试中",
    target: "待发布",
    actor: "system-poller",
    expiresAt: "2026-08-04T00:05:00.000Z",
    createdAt: NOW,
    ...overrides,
  };
}

test("flushOutbox executes pending status mutations and confirms them", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const calls = [];
  const client = {
    updateTaskStatus: async (id, status) => calls.push(["status", id, status]),
    updateCustomField: async (id, fieldId, value) => calls.push(["field", id, fieldId, value]),
  };
  await enqueueMutation(harness.db, mutationBase());
  const result = await flushOutbox(harness.db, client, { now: NOW, config: CONFIG });
  assert.deepEqual(result.flushed, ["mut-1"]);
  assert.deepEqual(calls, [["status", "task-1", "待发布"]]);
  const row = await harness.db
    .prepare("SELECT status, confirmed_at FROM outbox_mutations WHERE id = ?")
    .bind("mut-1")
    .first();
  assert.equal(row.status, "confirmed");
  assert.equal(row.confirmed_at, NOW);
});

test("flushOutbox skips already confirmed mutations", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  let calls = 0;
  const client = {
    updateTaskStatus: async () => { calls += 1; },
    updateCustomField: async () => { calls += 1; },
  };
  await enqueueMutation(harness.db, mutationBase());
  await flushOutbox(harness.db, client, { now: NOW, config: CONFIG });
  const second = await flushOutbox(harness.db, client, { now: NOW, config: CONFIG });
  assert.deepEqual(second.flushed, []);
  assert.equal(calls, 1);
});

test("flushOutbox expires stale mutations without executing them", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  let calls = 0;
  const client = {
    updateTaskStatus: async () => { calls += 1; },
    updateCustomField: async () => { calls += 1; },
  };
  await enqueueMutation(harness.db, mutationBase({
    expiresAt: "2026-08-04T00:00:10.000Z",
  }));
  const result = await flushOutbox(harness.db, client, { now: NOW, config: CONFIG });
  assert.deepEqual(result.flushed, []);
  assert.deepEqual(result.expired, ["mut-1"]);
  assert.equal(calls, 0);
  const row = await harness.db
    .prepare("SELECT status FROM outbox_mutations WHERE id = ?")
    .bind("mut-1")
    .first();
  assert.equal(row.status, "expired");
});

test("flushOutbox writes custom fields through the field id mapping", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const calls = [];
  const client = {
    updateTaskStatus: async () => {},
    updateCustomField: async (id, fieldId, value) => calls.push([id, fieldId, value]),
  };
  await enqueueMutation(harness.db, mutationBase({
    field: "操作请求",
    target: "测试通过",
  }));
  await flushOutbox(harness.db, client, { now: NOW, config: CONFIG });
  assert.deepEqual(calls, [["task-1", "field-request", "测试通过"]]);
});

test("confirmMutation idempotently confirms a mutation", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await enqueueMutation(harness.db, mutationBase());
  await confirmMutation(harness.db, "mut-1", NOW);
  await confirmMutation(harness.db, "mut-1", NOW);
  const row = await harness.db
    .prepare("SELECT status FROM outbox_mutations WHERE id = ?")
    .bind("mut-1")
    .first();
  assert.equal(row.status, "confirmed");
});

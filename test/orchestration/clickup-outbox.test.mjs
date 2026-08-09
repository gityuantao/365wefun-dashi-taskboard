import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { loadClickUpConfig } from "../../orchestration/clickup/config-registry.mjs";
import {
  confirmMutation,
  enqueueMutation,
  flushOutbox,
} from "../../orchestration/clickup/outbox.mjs";
import { saveSnapshot } from "../../orchestration/clickup/snapshot.mjs";

const CONFIG = loadClickUpConfig({
  teamId: "90161712199",
  spaceId: "90167718544",
  lists: {
    task: { id: "901616282651", name: "任务" },
    version: { id: "901616282740", name: "版本" },
    taskSandbox: { id: "901616314492", name: "任务-Sandbox" },
    versionSandbox: { id: "901616314494", name: "版本-Sandbox" },
  },
  taskStatusMap: {
    收件箱: "inbox",
    待补充信息: "waiting_info",
    待开发: "ready_for_development",
    开发中: "developing",
    待发布: "ready_for_release",
    测试中: "testing",
  },
  versionStatusMap: { 规划中: "planning" },
  fields: {
    task: {
      自动化纳管: { id: "field-managed", type: "checkbox" },
      执行摘要: { id: "field-summary", type: "text" },
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
  const remoteStatuses = ["测试中", "待发布"];
  const client = {
    getTask: async () => ({
      id: "task-1",
      status: { status: remoteStatuses.shift() },
    }),
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
  const remoteStatuses = ["测试中", "待发布"];
  const client = {
    getTask: async () => ({
      id: "task-1",
      status: { status: remoteStatuses.shift() },
    }),
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

test("flushOutbox cannot overwrite a confirmed manual 待补充信息 status", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: "task-1",
      listId: "901616282651",
      status: "waiting_info",
      targetVersion: "1.0.1",
      assignee: null,
      updatedAt: NOW,
      fieldsHash: "manual-waiting-info",
    },
    readAt: NOW,
  });
  let writes = 0;
  const client = {
    updateTaskStatus: async () => { writes += 1; },
    updateCustomField: async () => { writes += 1; },
  };
  await enqueueMutation(harness.db, mutationBase({
    mutationId: "stale-developing",
    expectedBefore: "待开发",
    target: "开发中",
  }));

  const result = await flushOutbox(harness.db, client, { now: NOW, config: CONFIG });

  assert.deepEqual(result.flushed, []);
  assert.deepEqual(result.expired, ["stale-developing"]);
  assert.equal(writes, 0);
  const row = await harness.db
    .prepare("SELECT status FROM outbox_mutations WHERE id = ?")
    .bind("stale-developing")
    .first();
  assert.equal(row.status, "expired");
});

test("flushOutbox trusts remote 待补充信息 over a stale local developing snapshot", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: "task-1",
      listId: "901616282651",
      status: "developing",
      targetVersion: "1.0.1",
      assignee: null,
      updatedAt: NOW,
      fieldsHash: "stale-local-developing",
    },
    readAt: NOW,
  });
  let writes = 0;
  const client = {
    getTask: async () => ({ id: "task-1", status: { status: "待补充信息" } }),
    updateTaskStatus: async () => { writes += 1; },
    updateCustomField: async () => { writes += 1; },
  };
  await enqueueMutation(harness.db, mutationBase({
    mutationId: "remote-waiting-info",
    expectedBefore: "待开发",
    target: "开发中",
  }));

  const result = await flushOutbox(harness.db, client, { now: NOW, config: CONFIG });

  assert.deepEqual(result.flushed, []);
  assert.deepEqual(result.expired, ["remote-waiting-info"]);
  assert.equal(writes, 0);
});

test("flushOutbox expires a status mutation when normalized remote state changed", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  let writes = 0;
  const client = {
    getTask: async () => ({ id: "task-1", status: { status: "开发中" } }),
    updateTaskStatus: async () => { writes += 1; },
    updateCustomField: async () => { writes += 1; },
  };
  await enqueueMutation(harness.db, mutationBase());

  const result = await flushOutbox(harness.db, client, { now: NOW, config: CONFIG });

  assert.deepEqual(result.flushed, []);
  assert.deepEqual(result.expired, ["mut-1"]);
  assert.equal(writes, 0);
  const row = await harness.db
    .prepare("SELECT status FROM outbox_mutations WHERE id = ?")
    .bind("mut-1")
    .first();
  assert.equal(row.status, "expired");
});

test("flushOutbox fails closed when authoritative remote state is unavailable", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  let writes = 0;
  const client = {
    updateTaskStatus: async () => { writes += 1; },
    updateCustomField: async () => { writes += 1; },
  };
  await enqueueMutation(harness.db, mutationBase());

  await assert.rejects(
    () => flushOutbox(harness.db, client, { now: NOW, config: CONFIG }),
    /REMOTE_STATE_UNAVAILABLE/,
  );

  assert.equal(writes, 0);
  const row = await harness.db
    .prepare("SELECT status FROM outbox_mutations WHERE id = ?")
    .bind("mut-1")
    .first();
  assert.equal(row.status, "pending");
});

test("flushOutbox leaves a successful status write pending until target readback", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  let writes = 0;
  const client = {
    getTask: async () => ({ id: "task-1", status: { status: "测试中" } }),
    updateTaskStatus: async () => { writes += 1; },
    updateCustomField: async () => {},
  };
  await enqueueMutation(harness.db, mutationBase());

  await assert.rejects(
    () => flushOutbox(harness.db, client, { now: NOW, config: CONFIG }),
    /REMOTE_CONFIRMATION_FAILED/,
  );

  assert.equal(writes, 1);
  const row = await harness.db
    .prepare("SELECT status, confirmed_at FROM outbox_mutations WHERE id = ?")
    .bind("mut-1")
    .first();
  assert.equal(row.status, "pending");
  assert.equal(row.confirmed_at, null);
});

test("flushOutbox reconciles an unknown write outcome before any retry", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const remoteStatuses = ["测试中", "待发布"];
  let writes = 0;
  let reads = 0;
  const client = {
    getTask: async () => {
      reads += 1;
      return { id: "task-1", status: { status: remoteStatuses.shift() } };
    },
    updateTaskStatus: async () => {
      writes += 1;
      throw new Error("socket closed after upload");
    },
    updateCustomField: async () => {},
  };
  await enqueueMutation(harness.db, mutationBase());

  const result = await flushOutbox(harness.db, client, { now: NOW, config: CONFIG });

  assert.deepEqual(result.flushed, ["mut-1"]);
  assert.equal(reads, 2);
  assert.equal(writes, 1);
  const row = await harness.db
    .prepare("SELECT status FROM outbox_mutations WHERE id = ?")
    .bind("mut-1")
    .first();
  assert.equal(row.status, "confirmed");
});

test("flushOutbox writes custom fields through the field id mapping", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const calls = [];
  const remoteValues = ["旧摘要", "测试摘要内容"];
  const client = {
    getTask: async () => ({
      id: "task-1",
      custom_fields: [{
        id: "field-summary",
        name: "执行摘要",
        type: "text",
        value: remoteValues.shift(),
      }],
    }),
    updateTaskStatus: async () => {},
    updateCustomField: async (id, fieldId, value) => calls.push([id, fieldId, value]),
  };
  await enqueueMutation(harness.db, mutationBase({
    field: "执行摘要",
    expectedBefore: "旧摘要",
    target: "测试摘要内容",
  }));
  const result = await flushOutbox(harness.db, client, { now: NOW, config: CONFIG });
  assert.deepEqual(calls, [["task-1", "field-summary", "测试摘要内容"]]);
  assert.deepEqual(result.flushed, ["mut-1"]);
});

test("flushOutbox does not overwrite a normalized custom-field value changed remotely", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  let writes = 0;
  const client = {
    getTask: async () => ({
      id: "task-1",
      custom_fields: [{
        id: "field-summary",
        name: "执行摘要",
        type: "text",
        value: { value: "人工修改" },
      }],
    }),
    updateTaskStatus: async () => {},
    updateCustomField: async () => { writes += 1; },
  };
  await enqueueMutation(harness.db, mutationBase({
    field: "执行摘要",
    expectedBefore: { value: "旧摘要" },
    target: "测试摘要内容",
  }));

  const result = await flushOutbox(harness.db, client, { now: NOW, config: CONFIG });

  assert.deepEqual(result.flushed, []);
  assert.deepEqual(result.expired, ["mut-1"]);
  assert.equal(writes, 0);
});

test("flushOutbox preserves value-bearing business objects when checking custom-field conflicts", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const target = { value: "next", currency: "USD", allocations: ["primary", "reserve"] };
  const remoteValues = [
    { value: "same", currency: "EUR", allocations: ["primary", "reserve"] },
    target,
  ];
  let writes = 0;
  const client = {
    getTask: async () => ({
      id: "task-1",
      custom_fields: [{
        id: "field-summary",
        name: "执行摘要",
        type: "text",
        value: remoteValues.shift(),
      }],
    }),
    updateTaskStatus: async () => {},
    updateCustomField: async () => { writes += 1; },
  };
  await enqueueMutation(harness.db, mutationBase({
    field: "执行摘要",
    expectedBefore: {
      value: "same",
      currency: "USD",
      allocations: ["primary", "reserve"],
    },
    target,
  }));

  const result = await flushOutbox(harness.db, client, { now: NOW, config: CONFIG });

  assert.deepEqual(result.flushed, []);
  assert.deepEqual(result.expired, ["mut-1"]);
  assert.equal(writes, 0);
});

test("flushOutbox accepts an identical complex custom-field value without losing JSON structure", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const remoteValues = [
    {
      allocations: ["primary", "reserve"],
      currency: "USD",
      value: "same",
    },
    {
      currency: "USD",
      value: "next",
      allocations: ["primary", "reserve"],
    },
  ];
  const writes = [];
  const client = {
    getTask: async () => ({
      id: "task-1",
      custom_fields: [{
        id: "field-summary",
        name: "执行摘要",
        type: "text",
        value: remoteValues.shift(),
      }],
    }),
    updateTaskStatus: async () => {},
    updateCustomField: async (id, field, value) => writes.push([id, field, value]),
  };
  await enqueueMutation(harness.db, mutationBase({
    field: "执行摘要",
    expectedBefore: {
      value: "same",
      currency: "USD",
      allocations: ["primary", "reserve"],
    },
    target: {
      value: "next",
      currency: "USD",
      allocations: ["primary", "reserve"],
    },
  }));

  const result = await flushOutbox(harness.db, client, { now: NOW, config: CONFIG });

  assert.deepEqual(result.flushed, ["mut-1"]);
  assert.deepEqual(writes, [[
    "task-1",
    "field-summary",
    { value: "next", currency: "USD", allocations: ["primary", "reserve"] },
  ]]);
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

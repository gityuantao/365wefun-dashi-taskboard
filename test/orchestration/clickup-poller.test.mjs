import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { loadClickUpConfig } from "../../orchestration/clickup/config-registry.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { pollClickUpOnce } from "../../cloud/src/clickup-poller.mjs";

const NOW = "2026-08-04T00:00:10.000Z";

const CONFIG = {
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
    分析中: "analyzing",
    待开发: "ready_for_development",
    开发中: "developing",
    待测试: "ready_for_test",
    测试中: "testing",
    待验收: "ready_for_acceptance",
    验收中: "accepting",
    待发布: "ready_for_release",
    已发布: "published",
    已取消: "canceled",
  },
  versionStatusMap: {
    规划中: "planning",
    进行中: "active",
    待发布: "ready_for_release",
    发布中: "releasing",
    发布失败: "release_failed",
    已发布: "published",
    已取消: "canceled",
  },
  fields: {
    task: {
      自动化纳管: { id: "field-managed", type: "checkbox" },
      操作请求: { id: "field-request", type: "drop_down" },
      操作请求ID: { id: "field-request-id", type: "short_text" },
      目标版本: { id: "field-version", type: "short_text" },
    },
    taskSandbox: {
      自动化纳管: { id: "field-managed", type: "checkbox" },
      操作请求: { id: "field-request", type: "drop_down" },
      操作请求ID: { id: "field-request-id", type: "short_text" },
      目标版本: { id: "field-version", type: "short_text" },
    },
    version: {
      操作请求: { id: "field-ver-request", type: "drop_down" },
      发布阻塞: { id: "field-ver-block", type: "drop_down" },
    },
    versionSandbox: {
      操作请求: { id: "field-ver-request", type: "drop_down" },
      发布阻塞: { id: "field-ver-block", type: "drop_down" },
    },
  },
};

function sandboxTask({ id = "task-1", status = "测试中", managed = true, request = "测试通过", requestId = "ev-test-1" } = {}) {
  return {
    id,
    name: "Sample",
    list: { id: "901616314492" },
    status: { status },
    custom_fields: [
      { id: "field-managed", name: "自动化纳管", value: managed },
      { id: "field-request", name: "操作请求", value: request },
      { id: "field-request-id", name: "操作请求ID", value: requestId },
      { id: "field-version", name: "目标版本", value: null },
    ],
    updated_at: NOW,
  };
}

async function makeEnv(harness, tasks) {
  return {
    DB: harness.db,
    CLICKUP_API_TOKEN: "pk-test",
    CLICKUP_CONFIG: JSON.stringify(CONFIG),
    CLICKUP_LIST_SET: "sandbox",
    clientFactory: async () => ({
      getTasksByList: async () => tasks,
      getVersionsByList: async () => [],
    }),
  };
}

async function dispatchTask(harness, id, type, version, parameters = {}) {
  return dispatchCommand({
    db: harness.db,
    command: parseCommandEnvelope({
      id,
      type,
      aggregateType: "task",
      aggregateId: "task-1",
      expectedVersion: version,
      actorId: "subject-1",
      issuedAt: NOW,
      reason: "poller test",
      parameters,
    }),
    now: NOW,
  });
}

test("poller saves snapshots and skips unmanaged tasks", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const env = await makeEnv(harness, [
    sandboxTask({ managed: false, request: null }),
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.processed, 1);
  assert.equal(result.commands.length, 0);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.version, 0);
});

test("poller turns a managed test-pass request into a command", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 5; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "start_test"][index];
    await dispatchTask(harness, `poll-task-cmd-${index}`, type, index + 1);
  }
  const env = await makeEnv(harness, [sandboxTask()]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.processed, 1);
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].type, "test_passed");
  assert.equal(result.commands[0].status, "succeeded");
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_acceptance");
  assert.equal(aggregate.version, 6);
});

test("poller passes the request id as evidence for test failures", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 5; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "start_test"][index];
    await dispatchTask(harness, `poll-task-cmd-${index}`, type, index + 1);
  }
  const env = await makeEnv(harness, [
    sandboxTask({ request: "测试不通过", requestId: "ev-fail-1" }),
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.commands[0].type, "test_failed");
  assert.equal(result.commands[0].status, "succeeded");
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_development");
});

test("poller is idempotent for unchanged snapshots", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 5; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "start_test"][index];
    await dispatchTask(harness, `poll-task-cmd-${index}`, type, index + 1);
  }
  const env = await makeEnv(harness, [sandboxTask()]);
  const first = await pollClickUpOnce(env, { now: NOW });
  assert.equal(first.commands.length, 1);
  const second = await pollClickUpOnce(env, { now: NOW });
  assert.equal(second.processed, 0);
  assert.equal(second.commands.length, 0);
});

test("poller records invalid commands without throwing", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const env = await makeEnv(harness, [
    sandboxTask({ status: "收件箱", request: "测试通过" }),
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.processed, 1);
  assert.equal(result.commands.length, 1);
  assert.match(result.commands[0].error ?? "", /INVALID_TRANSITION/);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.version, 0);
});

test("poller ignores operation requests that are not yet supported", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const env = await makeEnv(harness, [
    sandboxTask({ request: "纳入自动化" }),
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.processed, 1);
  assert.equal(result.commands.length, 0);
});

test("config registry validates the poller configuration", () => {
  const config = loadClickUpConfig(CONFIG);
  assert.equal(config.lists.taskSandbox.id, "901616314492");
  assert.equal(config.fields.taskSandbox["自动化纳管"].id, "field-managed");
});

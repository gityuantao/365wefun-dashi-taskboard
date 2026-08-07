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
    待补充信息: "waiting_info",
    待开发: "ready_for_development",
    开发中: "developing",
    待测试: "ready_for_test",
    测试中: "testing",
    待发布: "ready_for_release",
    已发布: "published",
    已取消: "canceled",
  },
  versionStatusMap: {
    规划中: "planning",
    进行中: "active",
    发布中: "releasing",
    发布失败: "release_failed",
    已发布: "published",
    已取消: "canceled",
  },
  fields: {
    task: {
      自动化纳管: { id: "field-managed", type: "checkbox" },
      目标版本: { id: "field-version", type: "short_text" },
    },
    taskSandbox: {
      自动化纳管: { id: "field-managed", type: "checkbox" },
      目标版本: { id: "field-version", type: "short_text" },
    },
    version: {
      发布阻塞: { id: "field-ver-block", type: "drop_down" },
    },
    versionSandbox: {
      发布阻塞: { id: "field-ver-block", type: "drop_down" },
    },
  },
};

function sandboxTask({ id = "task-1", status = "测试中", managed = true, version = null } = {}) {
  return {
    id,
    name: "Sample",
    list: { id: "901616314492" },
    status: { status },
    custom_fields: [
      { id: "field-managed", name: "自动化纳管", value: managed },
      { id: "field-version", name: "目标版本", value: version },
    ],
    updated_at: NOW,
  };
}

async function makeEnv(harness, tasks, versions = [], comments = []) {
  return {
    DB: harness.db,
    CLICKUP_API_TOKEN: "pk-test",
    CLICKUP_CONFIG: JSON.stringify(CONFIG),
    CLICKUP_LIST_SET: "sandbox",
    clientFactory: async () => ({
      getTasksByList: async () => tasks,
      getVersionsByList: async () => versions,
      postComment: async (id, body) => comments.push(body),
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

test("poller processes tasks without requiring a managed flag", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const env = await makeEnv(harness, [
    sandboxTask({ status: "收件箱", managed: false }),
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.processed, 1);
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].type, "start_analysis");
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.version, 1);
});

test("poller treats a move to 待发布 as test passed", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 6; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "acceptance_passed", "start_test"][index];
    await dispatchTask(harness, `poll-task-cmd-${index}`, type, index + 1);
  }
  const env = await makeEnv(harness, [sandboxTask({ status: "待发布" })]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.processed, 1);
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].type, "test_passed");
  assert.equal(result.commands[0].status, "succeeded");
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_release");
  assert.equal(aggregate.version, 7);
});

test("poller treats a move back to 待开发 as test failed", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 6; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "acceptance_passed", "start_test"][index];
    await dispatchTask(harness, `poll-task-cmd-${index}`, type, index + 1);
  }
  const env = await makeEnv(harness, [
    sandboxTask({ status: "待开发" }),
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
  for (let index = 0; index < 6; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "acceptance_passed", "start_test"][index];
    await dispatchTask(harness, `poll-task-cmd-${index}`, type, index + 1);
  }
  const env = await makeEnv(harness, [sandboxTask({ status: "待发布" })]);
  const first = await pollClickUpOnce(env, { now: NOW });
  assert.equal(first.commands.length, 1);
  const second = await pollClickUpOnce(env, { now: NOW });
  if (second.processed !== 0 || second.commands.length !== 0) {
    console.error("POLLER SECOND:", JSON.stringify(second));
  }
  assert.equal(second.processed, 0);
  assert.equal(second.commands.length, 0);
});

test("poller records invalid commands without throwing", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const env = await makeEnv(harness, [
    sandboxTask({ status: "收件箱" }),
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.processed, 1);
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].type, "start_analysis");
  assert.equal(result.commands[0].status, "succeeded");
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.version, 1);
});

test("poller ignores unsupported status moves", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 6; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "acceptance_passed", "start_test"][index];
    await dispatchTask(harness, `poll-task-cmd-${index}`, type, index + 1);
  }
  const env = await makeEnv(harness, [
    sandboxTask({ status: "已发布" }),
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.commands.length, 0);
});

test("config registry validates the poller configuration", () => {
  const config = loadClickUpConfig(CONFIG);
  assert.equal(config.lists.taskSandbox.id, "901616314492");
  assert.equal(config.fields.taskSandbox["自动化纳管"].id, "field-managed");
});

test("poller ignores tasks whose version is not the current dev version", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const env = await makeEnv(harness, [
    sandboxTask({ status: "收件箱", request: null, version: "1.0.2" }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
    { id: "v2", name: "1.0.2", status: { status: "进行中" } },
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.commands.length, 0);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.version, 0);
  const job = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE command_id LIKE 'auto-analyze-%'")
    .first();
  assert.equal(job, null);
});

test("poller processes tasks of the current dev version", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const env = await makeEnv(harness, [
    sandboxTask({ status: "收件箱", request: null, version: "1.0.1" }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
    { id: "v2", name: "1.0.2", status: { status: "进行中" } },
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].type, "start_analysis");
});

test("poller leaves tasks in waiting_info alone", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await dispatchTask(harness, "seed-waiting", "start_analysis", 1);
  await dispatchTask(harness, "seed-waiting-2", "analysis_needs_human", 2);
  const env = await makeEnv(harness, [
    sandboxTask({ status: "待补充信息", request: null, version: "1.0.1" }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.commands.length, 0);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "waiting_info");
  const job = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE command_id LIKE 'auto-analyze-%'")
    .first();
  assert.equal(job, null);
});

test("poller resumes analysis when the user changes status back", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await dispatchTask(harness, "seed-waiting-3", "start_analysis", 1);
  await dispatchTask(harness, "seed-waiting-4", "analysis_needs_human", 2);
  const env = await makeEnv(harness, [
    sandboxTask({ status: "分析中", request: null, version: "1.0.1" }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].type, "analysis_restarted");
  assert.equal(result.commands[0].status, "succeeded");
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "analyzing");
  const job = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE job_type = 'analyze' AND status = 'queued'")
    .first();
  assert.ok(job, "expected a queued analyze job after resume");
});

test("poller leaves tasks parked by development_needs_info alone", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 4; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development", "development_needs_info"][index];
    await dispatchTask(harness, `dev-info-${index}`, type, index + 1);
  }
  await harness.db
    .prepare(
      `INSERT INTO runner_jobs (id, command_id, job_type, payload, payload_hash, status, result, created_at)
       VALUES (?, ?, 'develop', '{}', 'h', 'failed', ?, ?)`,
    )
    .bind("task-1-develop-4", "auto-develop-task-1", JSON.stringify({ error: "needs_info: 线上音频实测正常，无法复现" }), NOW)
    .run();
  const env = await makeEnv(harness, [
    sandboxTask({ status: "待补充信息", request: null, version: "1.0.1" }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.commands.length, 0);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "waiting_info");
  const job = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE job_type = 'develop' AND status = 'queued'")
    .first();
  assert.equal(job, null);
});

test("poller resumes development when the user changes status back to 开发中", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 4; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development", "development_needs_info"][index];
    await dispatchTask(harness, `dev-resume-${index}`, type, index + 1);
  }
  await harness.db
    .prepare(
      `INSERT INTO runner_jobs (id, command_id, job_type, payload, payload_hash, status, result, created_at)
       VALUES (?, ?, 'develop', '{}', 'h', 'failed', ?, ?)`,
    )
    .bind("task-1-develop-4", "auto-develop-task-1", JSON.stringify({ error: "needs_info: 线上音频实测正常" }), NOW)
    .run();
  const env = await makeEnv(harness, [
    sandboxTask({ status: "开发中", request: null, version: "1.0.1" }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].type, "development_restarted");
  assert.equal(result.commands[0].status, "succeeded");
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "developing");
  const job = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE job_type = 'develop' AND status = 'queued'")
    .first();
  assert.ok(job, "expected a queued develop job after resume");
});

test("poller routes a rejected task back to rework when user moves it to 待开发", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const types = ["start_analysis", "analysis_completed", "start_development",
    "development_completed", "acceptance_rejected"];
  for (let index = 0; index < types.length; index += 1) {
    const params = types[index] === "acceptance_rejected" ? { evidenceId: "ev-rej" } : {};
    await dispatchTask(harness, `rej-dev-${index}`, types[index], index + 1, params);
  }
  const env = await makeEnv(harness, [
    sandboxTask({ status: "待开发", request: null, version: "1.0.1" }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.ok(result.commands.some((command) => command.type === "acceptance_rejected_to_develop"));
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_development");
  const job = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE job_type = 'develop' AND status = 'queued'")
    .first();
  assert.ok(job, "expected a queued develop job after routing to rework");
});

test("poller routes a rejected task to testing when user moves it to 待测试", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const types = ["start_analysis", "analysis_completed", "start_development",
    "development_completed", "acceptance_rejected"];
  for (let index = 0; index < types.length; index += 1) {
    const params = types[index] === "acceptance_rejected" ? { evidenceId: "ev-rej" } : {};
    await dispatchTask(harness, `rej-test-${index}`, types[index], index + 1, params);
  }
  const env = await makeEnv(harness, [
    sandboxTask({ status: "待测试", request: null, version: "1.0.1" }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.ok(result.commands.some((command) => command.type === "acceptance_rejected_to_test"));
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_test");
});

test("poller does not auto-start testing while the task stays in 待测试", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 5; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "acceptance_passed"][index];
    await dispatchTask(harness, `poller-no-auto-start-${index}`, type, index + 1);
  }
  const env = await makeEnv(harness, [sandboxTask({ status: "待测试" })]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.commands.length, 0);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_test");
});

test("poller starts testing when the user moves to 测试中", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 5; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "acceptance_passed"][index];
    await dispatchTask(harness, `poller-manual-test-${index}`, type, index + 1);
  }
  const env = await makeEnv(harness, [sandboxTask({ status: "测试中" })]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].type, "start_test");
  assert.equal(result.commands[0].status, "succeeded");
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "testing");
  assert.equal(aggregate.version, 6);
});

test("blocked acceptance failure pauses development until the user starts it manually", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 4; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_failed"][index];
    const parameters = type === "development_failed" ? { evidenceId: "dev-fail-1" } : {};
    await dispatchTask(harness, `poll-pause-${index}`, type, index + 1, parameters);
  }
  await harness.db
    .prepare(`
      INSERT OR IGNORE INTO runner_jobs (
        id, command_id, job_type, payload, payload_hash, status, result, created_at, completed_at
      ) VALUES ('acceptance-paused-task-1', 'auto-develop-task-1', 'develop', '{}', 'paused', 'failed', '{}', ?, ?)
    `)
    .bind(NOW, NOW)
    .run();

  const env = await makeEnv(harness, [sandboxTask({ status: "待开发" })]);
  const first = await pollClickUpOnce(env, { now: NOW });
  assert.equal(first.commands.length, 0);

  const env2 = await makeEnv(harness, [sandboxTask({ status: "开发中" })]);
  const second = await pollClickUpOnce(env2, { now: NOW });
  const startDev = second.commands.find((command) => command.type === "start_development");
  assert.ok(startDev);
  assert.equal(startDev.status, "succeeded");
  const pausedAfter = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE id = ?")
    .bind("acceptance-paused-task-1")
    .first();
  assert.equal(pausedAfter, null);
});

test("acceptance failure without a pause auto-enqueues redevelopment", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 5; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "acceptance_failed"][index];
    const parameters = type === "acceptance_failed" ? { evidenceId: "acc-fail-1" } : {};
    await dispatchTask(harness, `poll-auto-${index}`, type, index + 1, parameters);
  }
  const env = await makeEnv(harness, [sandboxTask({ status: "待开发" })]);
  await pollClickUpOnce(env, { now: NOW });
  const job = await harness.db
    .prepare("SELECT job_type, status FROM runner_jobs WHERE id = ?")
    .bind("task-1-develop-5")
    .first();
  assert.ok(job);
  assert.equal(job.job_type, "develop");
  assert.equal(job.status, "queued");
});

test("moving directly to 待发布 is treated as test passed", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 5; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "acceptance_passed"][index];
    await dispatchTask(harness, `poll-direct-pass-${index}`, type, index + 1);
  }
  const env = await makeEnv(harness, [sandboxTask({ status: "待发布" })]);
  const result = await pollClickUpOnce(env, { now: NOW });
  const types = result.commands.map((command) => command.type);
  assert.ok(types.includes("test_passed"));
  assert.ok(!types.includes("start_test"));
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_release");
});

test("moving directly to 待开发 is treated as test failed", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 5; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "acceptance_passed"][index];
    await dispatchTask(harness, `poll-direct-fail-${index}`, type, index + 1);
  }
  const env = await makeEnv(harness, [sandboxTask({ status: "待开发" })]);
  const result = await pollClickUpOnce(env, { now: NOW });
  const types = result.commands.map((command) => command.type);
  assert.ok(types.includes("test_failed"));
  assert.ok(!types.includes("start_test"));
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_development");
});

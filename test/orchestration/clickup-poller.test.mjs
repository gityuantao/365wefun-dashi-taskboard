import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { loadClickUpConfig } from "../../orchestration/clickup/config-registry.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { saveSnapshot } from "../../orchestration/clickup/snapshot.mjs";
import { pollClickUpOnce } from "../../cloud/src/clickup-poller.mjs";
import {
  claimJob,
  completeJob,
  enqueueJob,
} from "../../orchestration/persistence/d1-runner-jobs.mjs";

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

async function makeEnv(harness, tasks, versions = [], comments = [], fieldUpdates = []) {
  return {
    DB: harness.db,
    CLICKUP_API_TOKEN: "pk-test",
    CLICKUP_CONFIG: JSON.stringify(CONFIG),
    CLICKUP_LIST_SET: "sandbox",
    clientFactory: async () => ({
      getTasksByList: async () => tasks,
      getVersionsByList: async () => versions,
      postComment: async (id, body) => comments.push(body),
      updateCustomField: async (taskId, fieldId, value) => {
        fieldUpdates.push({ taskId, fieldId, value });
      },
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

async function seedOrdinaryDevelopmentFailure(harness) {
  for (let index = 0; index < 4; index += 1) {
    const type = [
      "start_analysis",
      "analysis_completed",
      "start_development",
      "development_failed",
    ][index];
    const parameters = type === "development_failed" ? { evidenceId: "dev-fail-1" } : {};
    await dispatchTask(harness, `ordinary-dev-failure-${index}`, type, index + 1, parameters);
  }
  await harness.db
    .prepare(
      `INSERT INTO runner_jobs (
        id, command_id, job_type, payload, payload_hash, status, result, created_at, completed_at
      ) VALUES (?, ?, 'develop', '{}', 'h', 'failed', ?, ?, ?)`,
    )
    .bind(
      "task-1-develop-2",
      "auto-develop-task-1",
      JSON.stringify({ error: "codex exited 2: build failed" }),
      NOW,
      NOW,
    )
    .run();
}

async function seedVersionAssignmentJob(harness, {
  generation = 1,
  status = "queued",
  createdAt = "2026-08-03T23:49:00.000Z",
  completedAt = "2026-08-03T23:50:00.000Z",
} = {}) {
  const jobId = `task-1-assign-version-${generation}`;
  await enqueueJob(harness.db, {
    jobId,
    commandId: "auto-assign-version-task-1",
    jobType: "assign_version",
    payload: { taskId: "task-1" },
    payloadHash: `assign-hash-${generation}`,
    expiresAt: "2026-08-04T00:30:00.000Z",
    createdAt,
  });
  if (status === "queued") return { jobId, claim: null };
  const claim = await claimJob(harness.db, {
    deviceId: "assign-device",
    jobType: "assign_version",
    now: createdAt,
    leaseMs: 60 * 60_000,
  });
  if (status === "claimed") return { jobId, claim };
  await completeJob(harness.db, {
    jobId,
    deviceId: "assign-device",
    fencingToken: claim.fencingToken,
    status,
    result: status === "failed" ? { error: "temporary AI failure" } : { ok: true },
    now: completedAt,
  });
  return { jobId, claim };
}

test("poller processes tasks without requiring a managed flag", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const env = await makeEnv(harness, [
    sandboxTask({ status: "收件箱", managed: false, version: "1.0.1" }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.processed, 2);
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
    sandboxTask({ status: "收件箱", version: "1.0.1" }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.processed, 2);
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

test("poller queues version selection before starting analysis for an unversioned inbox task", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const fieldUpdates = [];
  const env = await makeEnv(harness, [
    sandboxTask({ status: "收件箱", version: null }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
    { id: "v2", name: "1.0.2", status: { status: "进行中" } },
  ], [], fieldUpdates);

  const result = await pollClickUpOnce(env, { now: NOW });

  assert.deepEqual(fieldUpdates, []);
  assert.deepEqual(result.commands, []);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.version, 0);
  const statusMutation = await harness.db
    .prepare("SELECT id FROM outbox_mutations WHERE object_id = ? AND field = 'status'")
    .bind("task-1")
    .first();
  assert.equal(statusMutation, null);
  const jobs = await harness.db
    .prepare("SELECT job_type, status FROM runner_jobs WHERE json_extract(payload, '$.taskId') = ?")
    .bind("task-1")
    .all();
  assert.deepEqual(jobs.results, [{ job_type: "assign_version", status: "queued" }]);

  const second = await pollClickUpOnce(env, { now: NOW });
  assert.equal(second.processed, 0);
  assert.deepEqual(second.commands, []);
  const jobCount = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM runner_jobs WHERE job_type = 'assign_version'")
    .first();
  assert.equal(jobCount.count, 1);
});

test("poller keeps an unversioned inbox side-effect free when no unreleased version exists", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const env = await makeEnv(harness, [
    sandboxTask({ status: "收件箱", version: null }),
  ], [
    { id: "v0", name: "1.0.0", status: { status: "已发布" } },
  ]);

  const result = await pollClickUpOnce(env, { now: NOW });

  assert.deepEqual(result.commands, []);
  const job = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE job_type = 'assign_version'")
    .first();
  assert.equal(job, null);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.version, 0);
});

test("poller retries a failed version assignment with a new generation after backoff", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedVersionAssignmentJob(harness, { status: "failed" });
  const env = await makeEnv(harness, [
    sandboxTask({ status: "收件箱", version: null }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ]);

  await pollClickUpOnce(env, { now: NOW });

  const jobs = await harness.db
    .prepare("SELECT id, status FROM runner_jobs WHERE job_type = 'assign_version' ORDER BY id")
    .all();
  assert.deepEqual(jobs.results, [
    { id: "task-1-assign-version-1", status: "failed" },
    { id: "task-1-assign-version-2", status: "queued" },
  ]);
});

test("poller stops retrying after a retried version assignment completes", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedVersionAssignmentJob(harness, { status: "failed" });
  const tasks = [sandboxTask({ status: "收件箱", version: null })];
  const versions = [{ id: "v1", name: "1.0.1", status: { status: "进行中" } }];
  await pollClickUpOnce(await makeEnv(harness, tasks, versions), { now: NOW });
  const retry = await claimJob(harness.db, {
    deviceId: "assign-device-2",
    jobType: "assign_version",
    now: NOW,
  });
  await completeJob(harness.db, {
    jobId: retry.id,
    deviceId: "assign-device-2",
    fencingToken: retry.fencingToken,
    status: "completed",
    result: { assigned: true },
    now: NOW,
  });

  await pollClickUpOnce(await makeEnv(harness, tasks, versions), {
    now: "2026-08-04T00:10:10.000Z",
  });

  const count = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM runner_jobs WHERE job_type = 'assign_version'")
    .first();
  assert.equal(count.count, 2);
});

test("poller does not duplicate queued, claimed, or completed version assignment jobs", async (t) => {
  for (const status of ["queued", "claimed", "completed"]) {
    await t.test(status, async () => {
      const harness = await createCloudWorkerHarness();
      t.after(() => harness.dispose());
      await seedVersionAssignmentJob(harness, { status });
      const env = await makeEnv(harness, [
        sandboxTask({ status: "收件箱", version: null }),
      ], [
        { id: "v1", name: "1.0.1", status: { status: "进行中" } },
      ]);

      await pollClickUpOnce(env, { now: NOW });

      const count = await harness.db
        .prepare("SELECT COUNT(*) AS count FROM runner_jobs WHERE job_type = 'assign_version'")
        .first();
      assert.equal(count.count, 1);
    });
  }
});

test("poller honors the retry window for a recent failed version assignment", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedVersionAssignmentJob(harness, {
    status: "failed",
    createdAt: "2026-08-04T00:08:00.000Z",
    completedAt: "2026-08-04T00:09:00.000Z",
  });
  const env = await makeEnv(harness, [
    sandboxTask({ status: "收件箱", version: null }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ]);

  await pollClickUpOnce(env, { now: "2026-08-04T00:10:00.000Z" });

  const count = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM runner_jobs WHERE job_type = 'assign_version'")
    .first();
  assert.equal(count.count, 1);
});

test("poller starts analysis only after the selected current version is read back", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const versions = [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
    { id: "v2", name: "1.0.2", status: { status: "进行中" } },
  ];
  await pollClickUpOnce(await makeEnv(harness, [
    sandboxTask({ status: "收件箱", version: null }),
  ], versions), { now: NOW });

  const result = await pollClickUpOnce(await makeEnv(harness, [
    sandboxTask({ status: "收件箱", version: "1.0.1" }),
  ], versions), { now: NOW });

  assert.deepEqual(result.commands.map((command) => command.type), ["start_analysis"]);
  const analysisJob = await harness.db
    .prepare("SELECT status FROM runner_jobs WHERE job_type = 'analyze'")
    .first();
  assert.deepEqual(analysisJob, { status: "queued" });
});

test("poller keeps inbox blocked after a future version is read back", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const versions = [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
    { id: "v2", name: "1.0.2", status: { status: "进行中" } },
  ];
  await pollClickUpOnce(await makeEnv(harness, [
    sandboxTask({ status: "收件箱", version: null }),
  ], versions), { now: NOW });

  const result = await pollClickUpOnce(await makeEnv(harness, [
    sandboxTask({ status: "收件箱", version: "1.0.2" }),
  ], versions), { now: NOW });

  assert.deepEqual(result.commands, []);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.version, 0);
  const analysisJob = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE job_type = 'analyze'")
    .first();
  assert.equal(analysisJob, null);
  const statusMutation = await harness.db
    .prepare("SELECT id FROM outbox_mutations WHERE object_id = ? AND field = 'status'")
    .bind("task-1")
    .first();
  assert.equal(statusMutation, null);
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
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: "task-1",
      listId: "901616314492",
      status: "waiting_info",
      targetVersion: "1.0.1",
      assignee: null,
      updatedAt: "2026-08-04T00:00:00.000Z",
      fieldsHash: "analysis-waiting-before-resume",
    },
    readAt: "2026-08-04T00:00:00.000Z",
  });
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

test("manual 待补充信息 pauses active development and invalidates queued work", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 3; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development"][index];
    await dispatchTask(harness, `manual-pause-${index}`, type, index + 1);
  }
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: "task-1",
      listId: "901616314492",
      status: "developing",
      targetVersion: "1.0.1",
      assignee: null,
      updatedAt: "2026-08-04T00:00:00.000Z",
      fieldsHash: "confirmed-developing",
    },
    readAt: "2026-08-04T00:00:00.000Z",
  });
  await harness.db
    .prepare(
      `INSERT INTO runner_jobs (
        id, command_id, job_type, payload, payload_hash, status, expires_at, created_at
      ) VALUES (?, ?, 'develop', ?, 'h', 'queued', ?, ?)`,
    )
    .bind(
      "task-1-develop-3",
      "auto-develop-task-1",
      JSON.stringify({ taskId: "task-1" }),
      "2026-08-04T01:00:00.000Z",
      NOW,
    )
    .run();
  await harness.db
    .prepare(
      `INSERT INTO outbox_mutations (
        id, object_type, object_id, field, expected_before, target, actor,
        status, expires_at, created_at
      ) VALUES (?, 'task', ?, 'status', ?, ?, 'system-sync', 'pending', ?, ?)`,
    )
    .bind(
      "stale-developing-status",
      "task-1",
      JSON.stringify("待开发"),
      JSON.stringify("开发中"),
      "2026-08-04T01:00:00.000Z",
      NOW,
    )
    .run();
  const env = await makeEnv(harness, [
    sandboxTask({ status: "待补充信息", version: "1.0.1" }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ]);

  const result = await pollClickUpOnce(env, { now: NOW });

  assert.ok(result.commands.some((command) => command.type === "development_needs_info"));
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "waiting_info");
  const queued = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE id = ?")
    .bind("task-1-develop-3")
    .first();
  assert.equal(queued, null, "queued development must be canceled when the user pauses the task");
  const claimed = await claimJob(harness.db, {
    deviceId: "device-after-pause",
    jobType: "develop",
    now: NOW,
  });
  assert.equal(claimed, null, "paused work must not remain claimable");
  const mutation = await harness.db
    .prepare("SELECT status FROM outbox_mutations WHERE id = ?")
    .bind("stale-developing-status")
    .first();
  assert.equal(mutation.status, "expired", "stale status sync must not restore 开发中");
});

test("manual 待补充信息 pauses a non-current-version task before the version gate", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 3; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development"][index];
    await dispatchTask(harness, `gated-pause-${index}`, type, index + 1);
  }
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: "task-1",
      listId: "901616314492",
      status: "developing",
      targetVersion: "1.0.2",
      assignee: null,
      updatedAt: "2026-08-04T00:00:00.000Z",
      fieldsHash: "gated-developing",
    },
    readAt: "2026-08-04T00:00:00.000Z",
  });
  for (const [id, status] of [["queued-gated-develop", "queued"], ["claimed-gated-develop", "claimed"]]) {
    await harness.db
      .prepare(
        `INSERT INTO runner_jobs (
          id, command_id, job_type, payload, payload_hash, status, device_id,
          fencing_token, expires_at, created_at, claimed_at
        ) VALUES (?, 'auto-develop-task-1', 'develop', ?, 'h', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        JSON.stringify({ taskId: "task-1", aggregateVersion: 3 }),
        status,
        status === "claimed" ? "device-1" : null,
        status === "claimed" ? 1 : 0,
        "2026-08-04T01:00:00.000Z",
        NOW,
        status === "claimed" ? NOW : null,
      )
      .run();
  }
  const env = await makeEnv(harness, [
    sandboxTask({ status: "待补充信息", version: "1.0.2" }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
    { id: "v2", name: "1.0.2", status: { status: "进行中" } },
  ]);

  const result = await pollClickUpOnce(env, { now: NOW });

  assert.ok(result.commands.some((command) => command.type === "development_needs_info"));
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "waiting_info");
  const queued = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE id = 'queued-gated-develop'")
    .first();
  assert.equal(queued, null, "queued work must be canceled even when the version is gated");
  const claimed = await harness.db
    .prepare("SELECT status FROM runner_jobs WHERE id = 'claimed-gated-develop'")
    .first();
  assert.equal(claimed.status, "claimed", "claimed work must remain leased for cooperative stop");
});

test("manual 待补充信息 pauses a task that was queued for development", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await dispatchTask(harness, "ready-pause-analysis", "start_analysis", 1);
  await dispatchTask(harness, "ready-pause-complete", "analysis_completed", 2);
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: "task-1",
      listId: "901616314492",
      status: "ready_for_development",
      targetVersion: "1.0.1",
      assignee: null,
      updatedAt: "2026-08-04T00:00:00.000Z",
      fieldsHash: "confirmed-ready",
    },
    readAt: "2026-08-04T00:00:00.000Z",
  });
  const env = await makeEnv(harness, [
    sandboxTask({ status: "待补充信息", version: "1.0.1" }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ]);

  const result = await pollClickUpOnce(env, { now: NOW });

  assert.ok(result.commands.some((command) => command.type === "manual_pause_for_info"));
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "waiting_info");
  const queued = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE job_type = 'develop' AND status = 'queued'")
    .first();
  assert.equal(queued, null);
});

test("manual 待补充信息 pauses acceptance, cancels queued accept, and can resume to development", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 4; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development", "development_completed"][index];
    await dispatchTask(harness, `accept-pause-${index}`, type, index + 1);
  }
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: "task-1",
      listId: "901616314492",
      status: "developing",
      targetVersion: "1.0.1",
      assignee: null,
      updatedAt: "2026-08-04T00:00:00.000Z",
      fieldsHash: "accepting-before-pause",
    },
    readAt: "2026-08-04T00:00:00.000Z",
  });
  for (const [id, status] of [["queued-accept", "queued"], ["claimed-accept", "claimed"]]) {
    await harness.db
      .prepare(
        `INSERT INTO runner_jobs (
          id, command_id, job_type, payload, payload_hash, status, device_id,
          fencing_token, expires_at, created_at, claimed_at
        ) VALUES (?, 'auto-accept-task-1', 'accept', ?, 'h', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        JSON.stringify({ taskId: "task-1", aggregateVersion: 4 }),
        status,
        status === "claimed" ? "device-accept" : null,
        status === "claimed" ? 1 : 0,
        "2026-08-04T01:00:00.000Z",
        NOW,
        status === "claimed" ? NOW : null,
      )
      .run();
  }
  const versions = [{ id: "v1", name: "1.0.1", status: { status: "进行中" } }];
  const pauseEnv = await makeEnv(harness, [
    sandboxTask({ status: "待补充信息", version: "1.0.1" }),
  ], versions);

  const paused = await pollClickUpOnce(pauseEnv, { now: NOW });

  assert.ok(paused.commands.some((command) => command.type === "manual_pause_for_info"));
  let aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "waiting_info");
  assert.equal(
    await harness.db.prepare("SELECT id FROM runner_jobs WHERE id = 'queued-accept'").first(),
    null,
  );
  const claimed = await harness.db
    .prepare("SELECT status FROM runner_jobs WHERE id = 'claimed-accept'")
    .first();
  assert.equal(claimed.status, "claimed");

  const resumeEnv = await makeEnv(harness, [
    sandboxTask({ status: "开发中", version: "1.0.1" }),
  ], versions);
  const resumed = await pollClickUpOnce(resumeEnv, { now: NOW });
  assert.ok(resumed.commands.some((command) => command.type === "development_restarted"));
  aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "developing");
});

test("poller honors waiting_info after acceptance_passed already reached ready_for_test", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 5; index += 1) {
    const type = [
      "start_analysis",
      "analysis_completed",
      "start_development",
      "development_completed",
      "acceptance_passed",
    ][index];
    await dispatchTask(harness, `passed-before-pause-${index}`, type, index + 1);
  }
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: "task-1",
      listId: "901616314492",
      status: "developing",
      targetVersion: "1.0.1",
      assignee: null,
      updatedAt: "2026-08-04T00:00:00.000Z",
      fieldsHash: "acceptance-passed-before-pause",
    },
    readAt: "2026-08-04T00:00:00.000Z",
  });
  await harness.db
    .prepare(
      `INSERT INTO runner_jobs (
        id, command_id, job_type, payload, payload_hash, status, expires_at, created_at
      ) VALUES ('queued-accept-after-pass', 'auto-accept-task-1', 'accept', ?, 'h', 'queued', ?, ?)`,
    )
    .bind(
      JSON.stringify({ taskId: "task-1", aggregateVersion: 4 }),
      "2026-08-04T01:00:00.000Z",
      NOW,
    )
    .run();
  await harness.db
    .prepare(
      `INSERT INTO outbox_mutations (
        id, object_type, object_id, field, expected_before, target, actor,
        status, expires_at, created_at
      ) VALUES ('stale-ready-for-test', 'task', 'task-1', 'status', ?, ?,
        'system-sync', 'pending', ?, ?)`,
    )
    .bind(
      "开发中",
      JSON.stringify("待测试"),
      "2026-08-04T01:00:00.000Z",
      NOW,
    )
    .run();
  const env = await makeEnv(harness, [
    sandboxTask({ status: "待补充信息", version: "1.0.1" }),
  ], [{ id: "v1", name: "1.0.1", status: { status: "进行中" } }]);

  const result = await pollClickUpOnce(env, { now: NOW });

  assert.ok(result.commands.some((command) => command.type === "manual_pause_for_info"));
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "waiting_info");
  const queued = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE id = 'queued-accept-after-pass'")
    .first();
  assert.equal(queued, null);
  const mutation = await harness.db
    .prepare("SELECT status FROM outbox_mutations WHERE id = 'stale-ready-for-test'")
    .first();
  assert.equal(mutation.status, "expired");
});

test("unrelated ClickUp updates do not resume waiting tasks or delete ordinary failures", async (t) => {
  for (const mode of ["development", "analysis"]) {
    await t.test(mode, async (subtest) => {
      const harness = await createCloudWorkerHarness();
      subtest.after(() => harness.dispose());
      if (mode === "analysis") {
        await dispatchTask(harness, "strict-analysis-start", "start_analysis", 1);
        await dispatchTask(harness, "strict-analysis-wait", "analysis_needs_human", 2);
      } else {
        for (let index = 0; index < 4; index += 1) {
          const type = ["start_analysis", "analysis_completed", "start_development", "development_needs_info"][index];
          await dispatchTask(harness, `strict-dev-${index}`, type, index + 1);
        }
      }
      const status = mode === "analysis" ? "analyzing" : "developing";
      await saveSnapshot(harness.db, {
        type: "task",
        snapshot: {
          id: "task-1",
          listId: "901616314492",
          status,
          targetVersion: "1.0.1",
          assignee: null,
          updatedAt: "2026-08-04T00:00:00.000Z",
          fieldsHash: `confirmed-${status}`,
        },
        readAt: "2026-08-04T00:00:00.000Z",
      });
      const commandId = `auto-${mode === "analysis" ? "analyze" : "develop"}-task-1`;
      await harness.db
        .prepare(
          `INSERT INTO runner_jobs (
            id, command_id, job_type, payload, payload_hash, status, result, created_at, completed_at
          ) VALUES (?, ?, ?, ?, 'h', 'failed', ?, ?, ?)`,
        )
        .bind(
          `ordinary-${mode}-failure`,
          commandId,
          mode === "analysis" ? "analyze" : "develop",
          JSON.stringify({ taskId: "task-1" }),
          JSON.stringify({
            status: "failed",
            classification: "ordinary_failure",
            error: mode === "analysis"
              ? "parser says needs_human text was malformed"
              : "log contains needs_info but this is an ordinary crash",
          }),
          NOW,
          NOW,
        )
        .run();
      const env = await makeEnv(harness, [
        sandboxTask({
          status: mode === "analysis" ? "分析中" : "开发中",
          version: "1.0.1",
        }),
      ], [{ id: "v1", name: "1.0.1", status: { status: "进行中" } }]);

      const result = await pollClickUpOnce(env, { now: NOW });

      assert.equal(
        result.commands.some((command) => ["analysis_restarted", "development_restarted"].includes(command.type)),
        false,
      );
      const aggregate = await loadAggregate(harness.db, "task", "task-1");
      assert.equal(aggregate.state, "waiting_info");
      const failure = await harness.db
        .prepare("SELECT id FROM runner_jobs WHERE id = ?")
        .bind(`ordinary-${mode}-failure`)
        .first();
      assert.ok(failure, "ordinary failure text must not be deleted by substring matching");
    });
  }
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
    .bind(
      "task-1-develop-4",
      "auto-develop-task-1",
      JSON.stringify({ classification: "needs_info", error: "needs_info: 线上音频实测正常" }),
      NOW,
    )
    .run();
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: "task-1",
      listId: "901616314492",
      status: "waiting_info",
      targetVersion: "1.0.1",
      assignee: null,
      updatedAt: "2026-08-04T00:00:00.000Z",
      fieldsHash: "development-waiting-before-resume",
    },
    readAt: "2026-08-04T00:00:00.000Z",
  });
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

test("manual resume clears one claimed-development pause result and queues one retry", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  for (let index = 0; index < 4; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development", "development_needs_info"][index];
    await dispatchTask(harness, `claimed-resume-${index}`, type, index + 1);
  }
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: "task-1",
      listId: "901616314492",
      status: "waiting_info",
      targetVersion: "1.0.1",
      assignee: null,
      updatedAt: "2026-08-04T00:00:00.000Z",
      fieldsHash: "claimed-paused",
    },
    readAt: "2026-08-04T00:00:00.000Z",
  });
  await harness.db
    .prepare(
      `INSERT INTO runner_jobs (
        id, command_id, job_type, payload, payload_hash, status, result, created_at, completed_at
      ) VALUES (?, ?, 'develop', ?, 'h', 'failed', ?, ?, ?)`,
    )
    .bind(
      "claimed-paused-develop",
      "auto-develop-task-1",
      JSON.stringify({ taskId: "task-1", aggregateVersion: 3 }),
      JSON.stringify({
        status: "failed",
        classification: "paused_waiting_info",
        error: "stale develop job: task is in waiting_info at version 4",
      }),
      NOW,
      NOW,
    )
    .run();
  const versions = [{ id: "v1", name: "1.0.1", status: { status: "进行中" } }];
  const env = await makeEnv(harness, [
    sandboxTask({ status: "开发中", version: "1.0.1" }),
  ], versions);

  const result = await pollClickUpOnce(env, { now: NOW });

  assert.ok(result.commands.some((command) => command.type === "development_restarted"));
  const oldFailure = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE id = 'claimed-paused-develop'")
    .first();
  assert.equal(oldFailure, null);
  const queued = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM runner_jobs WHERE command_id = ? AND status = 'queued'")
    .bind("auto-develop-task-1")
    .first();
  assert.equal(queued.count, 1);

  await pollClickUpOnce(env, { now: NOW });
  const queuedAfterRepeat = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM runner_jobs WHERE command_id = ? AND status = 'queued'")
    .bind("auto-develop-task-1")
    .first();
  assert.equal(queuedAfterRepeat.count, 1, "manual resume must enqueue exactly once");
});

test("poller does not automatically requeue an ordinary failed development", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedOrdinaryDevelopmentFailure(harness);
  const env = await makeEnv(harness, [
    sandboxTask({ status: "待开发", version: "1.0.1" }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ]);

  await pollClickUpOnce(env, { now: NOW });

  const queued = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE command_id = ? AND status = 'queued'")
    .bind("auto-develop-task-1")
    .first();
  assert.equal(queued, null, "ordinary failure must remain blocked until an explicit manual retry");
});

test("poller retries a development-order waiting job after the retry window", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await dispatchTask(harness, "waiting-order-start", "start_analysis", 1);
  await dispatchTask(harness, "waiting-order-ready", "analysis_completed", 2);
  await harness.db
    .prepare(
      `INSERT INTO runner_jobs (
        id, command_id, job_type, payload, payload_hash, status, result, created_at, completed_at
      ) VALUES (?, ?, 'develop', '{}', 'h', 'failed', ?, ?, ?)`,
    )
    .bind(
      "task-1-develop-2",
      "auto-develop-task-1",
      JSON.stringify({ error: "waiting: predecessor task task-0 has not finished development" }),
      NOW,
      NOW,
    )
    .run();
  const env = await makeEnv(harness, [
    sandboxTask({ status: "待开发", version: "1.0.1" }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ]);

  await pollClickUpOnce(env, { now: "2026-08-04T00:06:10.000Z" });

  const job = await harness.db
    .prepare("SELECT status FROM runner_jobs WHERE id = ?")
    .bind("task-1-develop-2")
    .first();
  assert.equal(job.status, "queued", "development-order waiting should be retried automatically");
});

test("moving an ordinarily failed task from 待开发 to 开发中 allows one manual retry", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedOrdinaryDevelopmentFailure(harness);
  const versions = [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ];

  const waitingEnv = await makeEnv(harness, [
    sandboxTask({ status: "待开发", version: "1.0.1" }),
  ], versions);
  await pollClickUpOnce(waitingEnv, { now: NOW });

  const retryEnv = await makeEnv(harness, [
    sandboxTask({ status: "开发中", version: "1.0.1" }),
  ], versions);
  const result = await pollClickUpOnce(retryEnv, { now: NOW });

  assert.ok(result.commands.some((command) => command.type === "start_development"));
  const queued = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM runner_jobs WHERE command_id = ? AND status = 'queued'")
    .bind("auto-develop-task-1")
    .first();
  assert.equal(queued.count, 1, "explicit ClickUp status change should release one retry");

  await pollClickUpOnce(retryEnv, { now: NOW });
  const queuedAfterRepeatPoll = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM runner_jobs WHERE command_id = ? AND status = 'queued'")
    .bind("auto-develop-task-1")
    .first();
  assert.equal(queuedAfterRepeatPoll.count, 1, "unchanged status must not add another retry");
});

test("a stale developing ClickUp snapshot does not release an ordinary failure block", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedOrdinaryDevelopmentFailure(harness);
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: "task-1",
      listId: "901616314492",
      status: "developing",
      targetVersion: "1.0.1",
      assignee: null,
      updatedAt: "2026-08-04T00:00:00.000Z",
      fieldsHash: "stale-developing",
    },
    readAt: "2026-08-04T00:00:00.000Z",
  });
  const env = await makeEnv(harness, [
    sandboxTask({ status: "开发中", version: "1.0.1" }),
  ], [
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ]);

  const result = await pollClickUpOnce(env, { now: NOW });

  assert.equal(result.commands.some((command) => command.type === "start_development"), false);
  const failed = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM runner_jobs WHERE command_id = ? AND status = 'failed'")
    .bind("auto-develop-task-1")
    .first();
  assert.equal(failed.count, 1, "sync lag must not clear the failure record");
  const queued = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM runner_jobs WHERE command_id = ? AND status = 'queued'")
    .bind("auto-develop-task-1")
    .first();
  assert.equal(queued.count, 0, "sync lag must not queue a retry");
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

test("poller imports external task placed directly in 待开发 and enqueues develop", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const env = await makeEnv(harness, [
    sandboxTask({ status: "待开发" }),
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.processed, 1);
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands[0].type, "start_analysis");
  assert.equal(result.commands[1].type, "analysis_completed");
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_development");
  assert.equal(aggregate.version, 2);
  const job = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE job_type = 'develop' AND payload LIKE '%task-1%' LIMIT 1")
    .first();
  assert.ok(job, "develop job should be enqueued for external task");
  // 幂等：第二次轮询不再重复导入
  const second = await pollClickUpOnce(env, { now: NOW });
  assert.equal(second.commands.length, 0);
});

test("poller imports external task placed directly in 开发中", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const env = await makeEnv(harness, [
    sandboxTask({ status: "开发中" }),
  ]);
  const result = await pollClickUpOnce(env, { now: NOW });
  assert.equal(result.commands.length, 2);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_development");
  assert.equal(aggregate.version, 2);
  const job = await harness.db
    .prepare("SELECT id FROM runner_jobs WHERE job_type = 'develop' AND payload LIKE '%task-1%' LIMIT 1")
    .first();
  assert.ok(job, "develop job should be enqueued");
});

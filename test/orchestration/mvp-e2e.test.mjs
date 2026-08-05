import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { pollClickUpOnce } from "../../cloud/src/clickup-poller.mjs";
import { runCompanionOnce } from "../../orchestration/runner/companion.mjs";
import { executeAnalysis } from "../../orchestration/ai/analyzer.mjs";
import { executeDevelopment } from "../../orchestration/ai/developer.mjs";
import { executeAcceptance } from "../../orchestration/ai/acceptance.mjs";
import { handleTestDecision } from "../../orchestration/application/test-gate.mjs";
import { freezeManifest } from "../../orchestration/release/version-aggregator.mjs";
import { handleConfirmRelease } from "../../orchestration/application/release-commands.mjs";
import { createWebAdapter } from "../../orchestration/release/adapters/web.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { loadManifest } from "../../orchestration/release/version-aggregator.mjs";
import { createDomainEvent } from "../../orchestration/domain/events.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { appendCommandResult } from "../../orchestration/persistence/d1-event-store.mjs";
import { saveSnapshot } from "../../orchestration/clickup/snapshot.mjs";

const NOW = "2026-08-04T00:10:00.000Z";

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

function makeClickUpTask(overrides = {}) {
  return {
    id: "task-e2e-1",
    name: "录音回放按钮",
    description: "修复录音回放不可点击",
    list: { id: "901616314492" },
    status: { status: "收件箱" },
    custom_fields: [
      { id: "field-managed", name: "自动化纳管", value: true },
      { id: "field-request", name: "操作请求", value: null },
      { id: "field-request-id", name: "操作请求ID", value: null },
      { id: "field-version", name: "目标版本", value: "version-e2e-1" },
    ],
    updated_at: NOW,
    ...overrides,
  };
}

async function makeEnv(harness, taskProvider) {
  return {
    DB: harness.db,
    CLICKUP_API_TOKEN: "pk-e2e",
    CLICKUP_CONFIG: JSON.stringify(CONFIG),
    CLICKUP_LIST_SET: "sandbox",
    CLICKUP_REPO_PATH: "/tmp/repo-e2e",
    CLICKUP_WORKTREES_ROOT: "/tmp/repo-e2e/.wt",
    clientFactory: async () => ({
      getTasksByList: async () => [taskProvider()],
      getVersionsByList: async () => [
        { id: "version-e2e-1", name: "version-e2e-1", status: { status: "进行中" } },
      ],
      getTask: async () => taskProvider(),
      postComment: async () => ({}),
      updateCustomField: async () => ({}),
      updateTaskStatus: async () => ({}),
    }),
  };
}

async function seedActiveVersion(harness, versionId) {
  const event = await createDomainEvent({
    id: `e2e-seed-${versionId}`,
    sequence: 1,
    aggregateType: "version",
    aggregateId: versionId,
    aggregateVersion: 1,
    type: "version.activated",
    commandId: `e2e-seed-cmd-${versionId}`,
    actorId: "system",
    occurredAt: NOW,
    data: { from: "planning", to: "active" },
    previousHash: null,
  });
  await appendCommandResult(harness.db, {
    command: parseCommandEnvelope({
      id: `e2e-seed-cmd-${versionId}`,
      type: "activate_version",
      aggregateType: "version",
      aggregateId: versionId,
      expectedVersion: 1,
      actorId: "system",
      issuedAt: NOW,
      reason: "seed",
      parameters: {},
    }),
    events: [event],
    projection: { state: "active", snapshot: { kind: "version" } },
  });
}

test("complete MVP loop: ClickUp task to published version", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  let clickUpTask = makeClickUpTask();
  const env = await makeEnv(harness, () => clickUpTask);

  const codex = {
    run: async ({ prompt }) => {
      if (prompt.includes("研发分析器")) {
        return { exitCode: 0, stdout: JSON.stringify({
          scope: "实现录音回放按钮",
          acceptance_criteria: [{ id: "ac-1", criterion: "按钮可点击", verification: "手动测试" }],
          risks: [],
          open_questions: [],
        }), stderr: "" };
      }
      if (prompt.includes("验收器")) {
        return { exitCode: 0, stdout: JSON.stringify({
          acceptance_result: "accepted",
          criteria_results: [{ id: "ac-1", result: "passed" }],
          findings: [],
        }), stderr: "" };
      }
      return { exitCode: 0, stdout: JSON.stringify({ change_summary: "实现按钮", tests: [] }), stderr: "" };
    },
  };
  const gitOps = {
    createWorktree: async ({ taskId }) => ({ worktreePath: `/tmp/wt/${taskId}`, branch: `task/${taskId}` }),
    commitAll: async () => ({}),
    createPullRequest: async () => ({ url: "https://github.com/x/pull/99" }),
  };
  const deployer = {
    preflight: async () => ({ ok: true }),
    upload: async () => ({ object: "releases/v1/abc/index.html" }),
    switchEntry: async () => ({ url: "https://e365.example.com" }),
    healthCheck: async () => ({ ok: true, status: 200 }),
  };

  // 1) 纳管收件箱任务 -> 分析作业
  const firstPoll = await pollClickUpOnce(env, { now: NOW });
  assert.ok(firstPoll.commands.some((command) => command.type === "start_analysis"));

  // 2) Companion 领取并执行分析 -> 待开发
  const fetchImpl = async (url, init = {}) => {
    if (init.method === "POST") {
      return new Response(JSON.stringify({ status: "completed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const job = await claimFromQueue(harness, "analyze");
    return new Response(JSON.stringify({ job }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const analysisRun = await runCompanionOnce({
    apiUrl: "http://127.0.0.1:47823",
    deviceId: "device-e2e",
    jobType: "analyze",
    handlers: {
      analyze: async (job) => {
        try {
          return await executeAnalysis({
            job,
            db: harness.db,
            client: await env.clientFactory({}),
            codex,
            now: NOW,
          });
        } catch (error) {
          throw error;
        }
      },
    },
    fetchImpl,
  });
  assert.equal(analysisRun.claimed, true);
  assert.equal((await loadAggregate(harness.db, "task", "task-e2e-1")).state, "ready_for_development");

  // 3) ClickUp 状态推进到待开发后轮询 -> 开发作业
  clickUpTask = makeClickUpTask({ status: { status: "待开发" }, updated_at: "2026-08-04T00:10:30.000Z" });
  await pollClickUpOnce(env, { now: NOW });
  const developClaim = await claimFromQueue(harness, "develop");
  assert.equal(developClaim.id, "task-e2e-1-develop-2");
  const devResult = await executeDevelopment({
    job: developClaim,
    db: harness.db,
    client: await env.clientFactory({}),
    codex,
    gitOps,
    now: NOW,
  });
  assert.equal(devResult.status, "completed");
  assert.equal((await loadAggregate(harness.db, "task", "task-e2e-1")).state, "ready_for_test");

  // 4) 人工测试通过 -> 待验收
  const gate = await handleTestDecision({
    db: harness.db,
    taskId: "task-e2e-1",
    decision: "pass",
    actorId: "tester-e2e",
    actorRoles: ["tester"],
    now: NOW,
  });
  assert.equal(gate.status, "succeeded");

  // 5) ClickUp 状态到待验收后轮询 -> 验收作业
  clickUpTask = makeClickUpTask({ status: { status: "待验收" }, updated_at: "2026-08-04T00:11:00.000Z" });
  await pollClickUpOnce(env, { now: NOW });
  const acceptClaim = await claimFromQueue(harness, "accept");
  const acceptResult = await executeAcceptance({
    job: acceptClaim,
    db: harness.db,
    client: await env.clientFactory({}),
    codex,
    now: NOW,
  });
  assert.equal(acceptResult.status, "completed");
  assert.equal((await loadAggregate(harness.db, "task", "task-e2e-1")).state, "ready_for_release");

  // 6) 版本聚合与发布
  await seedActiveVersion(harness, "version-e2e-1");
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: "task-e2e-1",
      listId: "901616314492",
      status: "ready_for_release",
      managed: true,
      operationRequest: null,
      operationRequestId: null,
      targetVersion: "version-e2e-1",
      assignee: null,
      updatedAt: NOW,
      fieldsHash: "hash-e2e",
    },
    readAt: NOW,
  });
  const frozen = await freezeManifest({ db: harness.db, versionId: "version-e2e-1", now: NOW });
  assert.equal(frozen.status, "frozen");
  const manifest = await loadManifest({ db: harness.db, versionId: "version-e2e-1" });
  assert.deepEqual(manifest.taskIds, ["task-e2e-1"]);

  const release = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-e2e-1",
    actorId: "release-e2e",
    actorRoles: ["release_manager"],
    now: NOW,
    adapter: createWebAdapter({ deployer }),
  });
  assert.equal(release.status, "succeeded");
  assert.equal((await loadAggregate(harness.db, "version", "version-e2e-1")).state, "published");
  assert.equal((await loadAggregate(harness.db, "task", "task-e2e-1")).state, "published");
});

async function claimFromQueue(harness, jobType) {
  const row = await harness.db
    .prepare("SELECT * FROM runner_jobs WHERE job_type = ? AND status = 'queued' ORDER BY created_at LIMIT 1")
    .bind(jobType)
    .first();
  assert.ok(row, `expected a queued ${jobType} job`);
  return {
    id: row.id,
    commandId: row.command_id,
    jobType: row.job_type,
    payload: JSON.parse(row.payload),
    payloadHash: row.payload_hash,
    fencingToken: 1,
    expiresAt: row.expires_at,
  };
}

test("failed development blocks without advancing the task", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const clickUpTask = makeClickUpTask({ status: { status: "待开发" } });
  const env = await makeEnv(harness, () => clickUpTask);
  await pollClickUpOnce(env, { now: NOW });
  const claim = await claimFromQueue(harness, "develop");
  const result = await executeDevelopment({
    job: claim,
    db: harness.db,
    client: await env.clientFactory({}),
    codex: { run: async () => ({ exitCode: 3, stdout: "", stderr: "build failed" }) },
    gitOps: {
      createWorktree: async () => ({ worktreePath: "/tmp/wt/x", branch: "task/x" }),
      commitAll: async () => ({}),
      createPullRequest: async () => ({}),
    },
    now: NOW,
  });
  assert.equal(result.status, "failed");
  const aggregate = await loadAggregate(harness.db, "task", "task-e2e-1");
  assert.equal(aggregate.version, 0, "failed development must not advance the task");
});

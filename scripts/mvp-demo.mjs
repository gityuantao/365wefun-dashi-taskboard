// ClickUp 编排 MVP 一键演示（mock 模式）：打印完整闭环每一步的状态。
// 运行：node scripts/mvp-demo.mjs
import { createCloudWorkerHarness } from "../test/helpers/cloud-worker-harness.mjs";
import { pollClickUpOnce } from "../cloud/src/clickup-poller.mjs";
import { runCompanionOnce } from "../orchestration/runner/companion.mjs";
import { executeAnalysis } from "../orchestration/ai/analyzer.mjs";
import { executeDevelopment } from "../orchestration/ai/developer.mjs";
import { executeAcceptance } from "../orchestration/ai/acceptance.mjs";
import { handleTestDecision } from "../orchestration/application/test-gate.mjs";
import { freezeManifest, loadManifest } from "../orchestration/release/version-aggregator.mjs";
import { handleConfirmRelease } from "../orchestration/application/release-commands.mjs";
import { createWebAdapter } from "../orchestration/release/adapters/web.mjs";
import { loadAggregate } from "../orchestration/persistence/d1-aggregate-store.mjs";
import { createDomainEvent } from "../orchestration/domain/events.mjs";
import { parseCommandEnvelope } from "../orchestration/domain/commands.mjs";
import { appendCommandResult } from "../orchestration/persistence/d1-event-store.mjs";
import { saveSnapshot } from "../orchestration/clickup/snapshot.mjs";

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
    version: {},
    versionSandbox: {},
  },
};

function task(status) {
  return {
    id: "task-demo-1",
    name: "录音回放按钮",
    description: "修复录音回放不可点击",
    list: { id: "901616314492" },
    status: { status },
    custom_fields: [
      { id: "field-managed", name: "自动化纳管", value: true },
      { id: "field-version", name: "目标版本", value: "version-demo-1" },
    ],
    updated_at: NOW,
  };
}

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
    return { exitCode: 0, stdout: JSON.stringify({ change_summary: "实现录音回放按钮", tests: [] }), stderr: "" };
  },
};

async function claimFromQueue(db, jobType) {
  const row = await db
    .prepare("SELECT * FROM runner_jobs WHERE job_type = ? AND status = 'queued' ORDER BY created_at LIMIT 1")
    .bind(jobType)
    .first();
  if (!row) return null;
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

async function state(harness, type, id) {
  const aggregate = await loadAggregate(harness.db, type, id);
  return aggregate.state ?? "none";
}

const harness = await createCloudWorkerHarness();
try {
  let clickUpTask = task("收件箱");
  const env = {
    DB: harness.db,
    CLICKUP_API_TOKEN: "pk-demo",
    CLICKUP_CONFIG: JSON.stringify(CONFIG),
    CLICKUP_LIST_SET: "sandbox",
    CLICKUP_REPO_PATH: "/tmp/repo-demo",
    clientFactory: async () => ({
      getTasksByList: async () => [clickUpTask],
      getVersionsByList: async () => [],
      getTask: async () => clickUpTask,
      postComment: async () => ({}),
      updateCustomField: async () => ({}),
    }),
  };
  const gitOps = {
    createWorktree: async ({ taskId }) => ({ worktreePath: `/tmp/wt/${taskId}`, branch: `task/${taskId}` }),
    commitAll: async () => ({}),
    createPullRequest: async () => ({ url: "https://github.com/x/pull/101" }),
  };

  console.log("1. ClickUp 新建任务（收件箱，已纳管）");
  await pollClickUpOnce(env, { now: NOW });
  console.log("   -> 状态:", await state(harness, "task", "task-demo-1"), "（自动进入分析中，已入队 analyze 作业）");

  const analysisRun = await runCompanionOnce({
    apiUrl: "http://127.0.0.1:47823",
    deviceId: "device-demo",
    jobType: "analyze",
    handlers: { analyze: async (job) => executeAnalysis({
      job,
      db: harness.db,
      client: await env.clientFactory({}),
      codex,
      now: NOW,
    }) },
    fetchImpl: async (url, init = {}) => {
      if (init.method === "POST") {
        return new Response(JSON.stringify({ status: "completed" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const job = await claimFromQueue(harness.db, "analyze");
      return new Response(JSON.stringify({ job }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  console.log("2. AI 分析完成 ->", await state(harness, "task", "task-demo-1"), analysisRun.status === "completed" ? "" : "(失败)");

  clickUpTask = task("待开发");
  await pollClickUpOnce(env, { now: NOW });
  const developJob = await claimFromQueue(harness.db, "develop");
  const devResult = await executeDevelopment({
    job: developJob,
    db: harness.db,
    client: await env.clientFactory({}),
    codex,
    gitOps,
    now: NOW,
  });
  console.log("3. AI 开发完成（含 PR）->", await state(harness, "task", "task-demo-1"), devResult.status === "completed" ? `(PR ${devResult.pr.url})` : "(失败)");

  const gate = await handleTestDecision({
    db: harness.db,
    taskId: "task-demo-1",
    decision: "pass",
    actorId: "tester-demo",
    actorRoles: ["tester"],
    now: NOW,
  });
  console.log("4. 人工测试通过 ->", await state(harness, "task", "task-demo-1"), gate.status === "succeeded" ? "" : "(失败)");

  clickUpTask = task("待发布");
  await pollClickUpOnce(env, { now: NOW });
  const acceptJob = await claimFromQueue(harness.db, "accept");
  const acceptResult = await executeAcceptance({
    job: acceptJob,
    db: harness.db,
    client: await env.clientFactory({}),
    codex,
    now: NOW,
  });
  console.log("5. AI 验收通过 ->", await state(harness, "task", "task-demo-1"), acceptResult.status === "completed" ? "" : "(失败)");

  const versionId = "version-demo-1";
  const seedEvent = await createDomainEvent({
    id: `demo-seed-${versionId}`,
    sequence: 1,
    aggregateType: "version",
    aggregateId: versionId,
    aggregateVersion: 1,
    type: "version.activated",
    commandId: `demo-seed-cmd-${versionId}`,
    actorId: "system",
    occurredAt: NOW,
    data: { from: "planning", to: "active" },
    previousHash: null,
  });
  await appendCommandResult(harness.db, {
    command: parseCommandEnvelope({
      id: `demo-seed-cmd-${versionId}`,
      type: "activate_version",
      aggregateType: "version",
      aggregateId: versionId,
      expectedVersion: 1,
      actorId: "system",
      issuedAt: NOW,
      reason: "seed",
      parameters: {},
    }),
    events: [seedEvent],
    projection: { state: "active", snapshot: { kind: "version" } },
  });
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: "task-demo-1",
      listId: "901616314492",
      status: "ready_for_release",
      managed: true,
      targetVersion: versionId,
      assignee: null,
      updatedAt: NOW,
      fieldsHash: "demo",
    },
    readAt: NOW,
  });
  const frozen = await freezeManifest({ db: harness.db, versionId, now: NOW });
  const manifest = await loadManifest({ db: harness.db, versionId });
  console.log("6. 版本聚合通过，Manifest 冻结 ->", frozen.status, "(任务:", manifest.taskIds.join(","), ")");

  const release = await handleConfirmRelease({
    db: harness.db,
    versionId,
    actorId: "release-demo",
    actorRoles: ["release_manager"],
    now: NOW,
    adapter: createWebAdapter({
      deployer: {
        preflight: async () => ({ ok: true }),
        upload: async () => ({ object: "releases/v1/index.html" }),
        switchEntry: async () => ({ url: "https://e365.example.com" }),
        healthCheck: async () => ({ ok: true, status: 200 }),
      },
    }),
  });
  console.log("7. 确认发布 ->", release.status === "succeeded" ? "已发布" : release.error);
  console.log("   -> 版本:", await state(harness, "version", versionId), "| 任务:", await state(harness, "task", "task-demo-1"));
} finally {
  await harness.dispose();
}

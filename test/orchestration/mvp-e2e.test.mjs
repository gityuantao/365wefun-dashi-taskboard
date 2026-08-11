import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { pollClickUpOnce } from "../../cloud/src/clickup-poller.mjs";
import { runCompanionOnce } from "../../orchestration/runner/companion.mjs";
import { executeAnalysis } from "../../orchestration/ai/analyzer.mjs";
import { executeDevelopment } from "../../orchestration/ai/developer.mjs";
import { executeAcceptance } from "../../orchestration/ai/acceptance.mjs";
import { handleTestDecision } from "../../orchestration/application/test-gate.mjs";
import { executeStagingGate } from "../../orchestration/application/staging-coordinator.mjs";
import { freezeManifest } from "../../orchestration/release/version-aggregator.mjs";
import { handleConfirmRelease } from "../../orchestration/application/release-commands.mjs";
import { executeProductionRelease } from "../../orchestration/application/production-release-coordinator.mjs";
import { coordinateReleaseSnapshot } from "../../orchestration/application/release-coordinator.mjs";
import { startDashboardServer } from "../../orchestration/dashboard/http-server.mjs";
import { seedDashboardFixture } from "../helpers/dashboard-fixture.mjs";
import { createWebAdapter } from "../../orchestration/release/adapters/web.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { loadManifest } from "../../orchestration/release/version-aggregator.mjs";
import { createDomainEvent } from "../../orchestration/domain/events.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { appendCommandResult } from "../../orchestration/persistence/d1-event-store.mjs";
import { saveSnapshot } from "../../orchestration/clickup/snapshot.mjs";
import { loadLastConfirmed } from "../../orchestration/clickup/snapshot.mjs";
import { flushOutbox } from "../../orchestration/clickup/outbox.mjs";

const NOW = "2026-08-04T00:10:00.000Z";
const CANDIDATE_COMMIT = "1111111111111111111111111111111111111111";
const CANDIDATE_ARTIFACT = {
  digest: "sha256:e2e-candidate-v1",
  object: "releases/version-e2e-1/sha256:e2e-candidate-v1",
};
const MINIMAL_PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2,
  0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5, 1, 1, 39, 24, 227, 102,
  0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);
const REJECTION_IMAGE_URL = "https://attachments.clickup.com/e2e-rejection.png";

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
      影响平台: { id: "field-platforms", type: "labels" },
    },
    taskSandbox: {
      自动化纳管: { id: "field-managed", type: "checkbox" },
      目标版本: { id: "field-version", type: "short_text" },
      影响平台: { id: "field-platforms", type: "labels" },
    },
    version: {
      发布阻塞: { id: "field-ver-block", type: "drop_down" },
    },
    versionSandbox: {
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
      { id: "field-version", name: "目标版本", value: "version-e2e-1" },
      {
        id: "field-platforms",
        name: "影响平台",
        value: ["platform-web", "platform-ios"],
        type_config: {
          options: [
            { id: "platform-web", label: "Web" },
            { id: "platform-ios", label: "iOS" },
          ],
        },
      },
    ],
    updated_at: NOW,
    ...overrides,
  };
}

async function makeEnv(
  harness,
  taskProvider,
  commentsProvider = () => [],
  attachmentProvider = () => null,
  versionProvider = () => ({ id: "version-e2e-1", name: "version-e2e-1", status: { status: "进行中" } }),
) {
  return {
    DB: harness.db,
    CLICKUP_API_TOKEN: "pk-e2e",
    CLICKUP_CONFIG: JSON.stringify(CONFIG),
    CLICKUP_LIST_SET: "sandbox",
    CLICKUP_REPO_PATH: "/tmp/repo-e2e",
    CLICKUP_WORKTREES_ROOT: "/tmp/repo-e2e/.wt",
    clientFactory: async () => ({
      getTasksByList: async () => [taskProvider()],
      getVersionsByList: async () => [versionProvider()],
      getTask: async () => taskProvider(),
      getComments: async () => commentsProvider(),
      downloadAttachment: async (url) => {
        const attachment = attachmentProvider(url);
        if (!attachment) {
          throw Object.assign(new Error("ClickUp attachment not found"), { code: "HTTP_404" });
        }
        const body = Uint8Array.from(attachment.body);
        return {
          body,
          contentType: attachment.contentType,
          contentLength: body.byteLength,
        };
      },
      postComment: async () => ({}),
      updateTaskDescription: async () => ({}),
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

async function seedAcceptingTask(harness, taskId) {
  const types = [
    "start_analysis",
    "analysis_completed",
    "start_development",
    "development_completed",
  ];
  for (let index = 0; index < types.length; index += 1) {
    const type = types[index];
    const aggregate = await loadAggregate(harness.db, "task", taskId);
    await dispatchCommand({
      db: harness.db,
      command: parseCommandEnvelope({
        id: `${taskId}-infra-rejected-${index}`,
        type,
        aggregateType: "task",
        aggregateId: taskId,
        expectedVersion: aggregate.version + 1,
        actorId: "test",
        issuedAt: NOW,
        reason: "seed infrastructure rejection",
        parameters: {},
      }),
      now: NOW,
    });
  }
}

async function inspectLiveCodexImage(options) {
  assert.equal(options.imagePaths.length, 1);
  const [imagePath] = options.imagePaths;
  const imageDirectory = path.dirname(imagePath);
  assert.match(path.basename(imageDirectory), /^taskboard-clickup-images-/);
  await access(imagePath);
  await access(imageDirectory);
  assert.deepEqual(new Uint8Array(await readFile(imagePath)), MINIMAL_PNG);
  return imageDirectory;
}

test("complete MVP loop preserves an image-only rejection through development and acceptance", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  let clickUpTask = makeClickUpTask();
  let clickUpComments = [];
  const clickUpAttachments = new Map([
    [REJECTION_IMAGE_URL, { body: MINIMAL_PNG, contentType: "image/png" }],
  ]);
  const env = await makeEnv(
    harness,
    () => clickUpTask,
    () => clickUpComments,
    (url) => clickUpAttachments.get(url),
  );
  let developmentCodexOptions;
  let acceptanceCodexOptions;
  let developmentImageDirectory;
  let acceptanceImageDirectory;

  const codex = {
    run: async (options) => {
      const { prompt } = options;
      if (prompt.startsWith("你是研发分析器")) {
        return { exitCode: 0, stdout: JSON.stringify({
          scope: "实现录音回放按钮",
          acceptance_criteria: [{ id: "ac-1", criterion: "按钮可点击", verification: "手动测试" }],
          risks: [],
          open_questions: [],
        }), stderr: "" };
      }
      if (prompt.startsWith("你是代码验收器")) {
        acceptanceCodexOptions = options;
        acceptanceImageDirectory = await inspectLiveCodexImage(options);
        return { exitCode: 0, stdout: JSON.stringify({
          acceptance_result: "accepted",
          criteria_results: [{ id: "ac-1", result: "passed" }],
          findings: [],
        }), stderr: "" };
      }
      developmentCodexOptions = options;
      developmentImageDirectory = await inspectLiveCodexImage(options);
      return { exitCode: 0, stdout: JSON.stringify({ change_summary: "实现按钮", tests: [] }), stderr: "" };
    },
  };
  const gitOps = {
    createWorktree: async ({ taskId }) => ({ worktreePath: `/tmp/wt/${taskId}`, branch: `task/${taskId}` }),
    commitAll: async () => "2222222222222222222222222222222222222222",
    createPullRequest: async () => ({ url: "https://github.com/x/pull/99" }),
  };
  let publishedDeployment = null;
  const deployer = {
    preflight: async () => ({ ok: true }),
    upload: async ({ candidateCommit, artifactIdentity }) => ({
      object: "releases/v1/abc/index.html",
      candidateCommit,
      artifactIdentity,
      externalRequestId: "request-1",
    }),
    switchEntry: async ({ candidateCommit, artifactIdentity }) => {
      publishedDeployment = {
        confirmed: true,
        published: true,
        status: "published",
        authoritative: true,
        candidateCommit,
        artifactIdentity: structuredClone(artifactIdentity),
        url: "https://e365.example.com",
        externalRequestId: "request-1",
        productionReleaseId: "release-1",
        healthStatus: "healthy",
        evidence: { source: "production-readback" },
      };
      return { url: publishedDeployment.url, productionReleaseId: "release-1" };
    },
    healthCheck: async () => ({ ok: true, status: 200 }),
    readback: async () => structuredClone(publishedDeployment),
  };

  // 1) 纳管收件箱任务 -> 分析作业
  const firstPoll = await pollClickUpOnce(env, { now: NOW });
  assert.ok(firstPoll.commands.some((command) => command.type === "start_analysis"));

  // 2) Companion 领取并执行分析 -> 待开发
  const fetchImpl = async (url, init = {}) => {
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      const jobId = new URL(url).pathname.split("/").at(-2);
      await harness.db.prepare(
        "UPDATE runner_jobs SET status = ?, result = ?, completed_at = ? WHERE id = ?",
      ).bind(body.status, JSON.stringify(body.result), NOW, jobId).run();
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
  clickUpComments = [
    { id: "comment-e2e-older", date: "1785751200000", comment_text: "上一轮验收记录" },
    {
      id: "comment-e2e-rejection",
      date: "1785751260000",
      attachments: [{ title: "e2e-rejection.png", url: REJECTION_IMAGE_URL }],
    },
  ];
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
  assert.equal(devResult.status, "completed", JSON.stringify(devResult));
  assert.deepEqual(devResult.platforms, ["web", "ios"]);
  assert.equal(developmentCodexOptions.imagePaths.length, 1);
  assert.match(developmentCodexOptions.prompt, /评论 comment-e2e-rejection 图片：e2e-rejection\.png/);
  await assert.rejects(access(developmentCodexOptions.imagePaths[0]));
  await assert.rejects(access(developmentImageDirectory));
  assert.equal((await loadAggregate(harness.db, "task", "task-e2e-1")).state, "accepting");
  await harness.db.prepare(
    "UPDATE runner_jobs SET status = 'completed', result = ?, completed_at = ? WHERE id = ?",
  ).bind(JSON.stringify(devResult), NOW, developClaim.id).run();

  // 4) 系统自动验收通过 -> 部署测试环境 -> 待测试
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
  assert.equal(acceptanceCodexOptions.imagePaths.length, 1);
  assert.match(acceptanceCodexOptions.prompt, /评论 comment-e2e-rejection 图片：e2e-rejection\.png/);
  await assert.rejects(access(acceptanceCodexOptions.imagePaths[0]));
  await assert.rejects(access(acceptanceImageDirectory));
  assert.equal((await loadAggregate(harness.db, "task", "task-e2e-1")).state, "accepting");
  await harness.db.prepare(
    "UPDATE runner_jobs SET status = 'completed', result = ?, completed_at = ? WHERE id = ?",
  ).bind(JSON.stringify(acceptResult), NOW, acceptClaim.id).run();
  await pollClickUpOnce(env, { now: NOW });
  const stageClaim = await claimFromQueue(harness, "stage_task");
  assert.deepEqual(stageClaim.payload.platforms, ["web", "ios"]);
  const stageResult = await executeStagingGate({
    job: stageClaim,
    db: harness.db,
    client: await env.clientFactory({}),
    gitOps: {
      integrateTaskPr: async () => ({
        merged: true,
        candidateCommit: CANDIDATE_COMMIT,
        taskHead: "2222222222222222222222222222222222222222",
        prNumber: 99,
      }),
      persistCandidate: async () => ({ persisted: true }),
    },
    adapter: {
      deploy: async () => ({ releaseId: "staging-e2e", url: "https://test.example" }),
      readback: async () => ({
        confirmed: true,
        releaseId: "staging-e2e",
        gitSha: CANDIDATE_COMMIT,
        urls: ["https://test.example"],
        deployedAt: NOW,
      }),
    },
    iosApps: [
      {
        id: "au",
        name: "海外版",
        enabled: true,
        scheme: "E365AU",
        testScheme: "E365AU",
        testTarget: "E365StoreKitTests",
        bundleId: "online.365english.app",
        testFlightGroup: "Internal Testing AU",
        buildNumberSource: "app-store-connect",
        appStoreAppId: "0000000001",
        releaseMode: "automatic",
        reviewConfigurationRef: "app-store-review/au",
      },
      {
        id: "cn",
        name: "中国版",
        enabled: true,
        scheme: "E365CN",
        testScheme: "E365ChinaComplianceTests",
        testTarget: "E365ChinaComplianceTests",
        bundleId: "online.365english.china",
        testFlightGroup: "Internal Testing CN",
        buildNumberSource: "app-store-connect",
        appStoreAppId: "0000000002",
        releaseMode: "automatic",
        reviewConfigurationRef: "app-store-review/cn",
      },
    ],
    iosAdapter: {
      stage: async ({ app, targetVersion }) => ({
        appId: app.id,
        scheme: app.scheme,
        bundleId: app.bundleId,
        marketingVersion: targetVersion,
        buildNumber: app.id === "au" ? "101" : "202",
        uploadId: `upload-${app.id}`,
      }),
      readback: async ({ app }) => ({
        processed: true,
        processingStatus: "processed",
        testGroup: app.testFlightGroup,
        membershipConfirmed: true,
        checkedAt: NOW,
      }),
    },
    now: NOW,
  });
  assert.equal(stageResult.status, "completed", JSON.stringify(stageResult));
  assert.equal((await loadAggregate(harness.db, "task", "task-e2e-1")).state, "ready_for_test");

  // 5) 人工测试通过 -> 待发布
  const gate = await handleTestDecision({
    db: harness.db,
    taskId: "task-e2e-1",
    decision: "pass",
    actorId: "tester-e2e",
    actorRoles: ["tester"],
    now: NOW,
  });
  assert.equal(gate.status, "succeeded");
  assert.equal((await loadAggregate(harness.db, "task", "task-e2e-1")).state, "ready_for_release");

  // 6) ClickUp 状态到待发布后轮询 -> 版本聚合与发布
  clickUpTask = makeClickUpTask({ status: { status: "待发布" }, updated_at: "2026-08-04T00:11:00.000Z" });
  await pollClickUpOnce(env, { now: NOW });

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
  const frozen = await freezeManifest({
    db: harness.db,
    versionId: "version-e2e-1",
    now: NOW,
    versionBranch: "version/version-e2e-1",
    candidateCommit: CANDIDATE_COMMIT,
    candidateRef: `refs/heads/release-candidate/version-e2e-1/${CANDIDATE_COMMIT}`,
    taskPrHeads: [{
      taskId: "task-e2e-1",
      branch: "task/task-e2e-1",
      headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      prNumber: 99,
      repository: "x/repo",
    }],
    artifactIdentity: CANDIDATE_ARTIFACT,
    regressionEvidence: {
      passed: true,
      command: "node --test test/orchestration/*.test.mjs",
      collectedAt: NOW,
    },
    productionTargetPlan: {
      schemaVersion: 1,
      taskPlatforms: [{ taskId: "task-e2e-1", platforms: ["web"] }],
      platforms: { web: true, api: false, ios: false },
      iosApps: [],
    },
  });
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
    targetPlanValidated: true,
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
  assert.equal(aggregate.state, "ready_for_development");
  const events = await harness.db
    .prepare(
      `SELECT aggregate_version, type
       FROM orchestration_events
       WHERE aggregate_type = ? AND aggregate_id = ?
       ORDER BY aggregate_version`,
    )
    .bind("task", "task-e2e-1")
    .all();
  assert.deepEqual(events.results, [
    { aggregate_version: 1, type: "task.analysis_started" },
    { aggregate_version: 2, type: "task.analysis_completed" },
    { aggregate_version: 3, type: "task.development_started" },
    { aggregate_version: 4, type: "task.development_failed" },
  ]);
});

test("missing adapter rejection resumes staging after configuration is restored", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const taskId = "task-e2e-1";
  await seedAcceptingTask(harness, taskId);
  const persistedPayload = {
    taskId,
    pr: { url: "https://github.com/x/pull/99" },
    commitSha: "2222222222222222222222222222222222222222",
    versionBranch: "version/version-e2e-1",
    targetVersion: "version-e2e-1",
    platforms: ["web"],
  };
  await harness.db.prepare(
    `INSERT INTO runner_jobs (
       id, command_id, job_type, payload, payload_hash, status, result, created_at, completed_at
     ) VALUES (?, ?, 'stage_task', ?, ?, 'completed', ?, ?, ?)`,
  ).bind(
    `${taskId}-stage_task-4`,
    `auto-stage_task-${taskId}`,
    JSON.stringify(persistedPayload),
    "accepted-evidence",
    JSON.stringify({ status: "failed", classification: "staging_infrastructure" }),
    NOW,
    NOW,
  ).run();
  const initialFailure = await executeStagingGate({
    job: { id: `${taskId}-stage_task-4`, payload: persistedPayload },
    db: harness.db,
    client: { postComment: async () => ({}) },
    gitOps: {
      integrateTaskPr: async () => {
        throw new Error("merge must not run without a staging adapter");
      },
      persistCandidate: async () => {
        throw new Error("persist must not run without a staging adapter");
      },
    },
    adapter: null,
    now: NOW,
  });
  await harness.db.prepare(
    "UPDATE runner_jobs SET status = 'failed', result = ?, completed_at = ? WHERE id = ?",
  ).bind(
    JSON.stringify(initialFailure),
    NOW,
    `${taskId}-stage_task-4`,
  ).run();
  const failedAttempt = await harness.db.prepare(
    `SELECT status, stage, failure_owner
     FROM staging_deployments WHERE task_id = ? ORDER BY attempt DESC LIMIT 1`,
  ).bind(taskId).first();
  assert.equal(initialFailure.status, "failed");
  assert.equal(initialFailure.stage, "preflight");
  assert.equal(failedAttempt.status, "failed");
  assert.equal(failedAttempt.stage, "preflight");
  assert.equal(failedAttempt.failure_owner, "staging_infrastructure");
  assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "acceptance_rejected");
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: taskId,
      listId: "901616314492",
      status: "acceptance_rejected",
      targetVersion: "version-e2e-1",
      assignee: null,
      updatedAt: "2026-08-04T00:00:00.000Z",
      fieldsHash: "rejected-snapshot",
    },
    readAt: NOW,
  });
  const clickUpTask = makeClickUpTask({
    status: { status: "待开发" },
    updated_at: "2026-08-04T00:10:30.000Z",
  });
  const env = await makeEnv(harness, () => clickUpTask);

  const recovery = await pollClickUpOnce(env, { now: NOW });

  assert.ok(recovery.commands.some((command) => command.type === "retry_staging"));
  const developJob = await harness.db.prepare(
    "SELECT id FROM runner_jobs WHERE job_type = 'develop' AND status = 'queued'",
  ).first();
  assert.equal(developJob, null);
  const stageClaim = await claimFromQueue(harness, "stage_task");
  assert.deepEqual(stageClaim.payload, { ...persistedPayload, aggregateVersion: 6 });
  const stageResult = await executeStagingGate({
    job: stageClaim,
    db: harness.db,
    client: await env.clientFactory({}),
    gitOps: {
      integrateTaskPr: async () => ({
        merged: true,
        candidateCommit: CANDIDATE_COMMIT,
        taskHead: persistedPayload.commitSha,
        prNumber: 99,
      }),
      persistCandidate: async () => ({ persisted: true }),
    },
    adapter: {
      deploy: async () => ({ releaseId: "staging-retry", url: "https://test.example" }),
      readback: async () => ({
        confirmed: true,
        releaseId: "staging-retry",
        gitSha: CANDIDATE_COMMIT,
        urls: ["https://test.example"],
        deployedAt: NOW,
      }),
    },
    now: NOW,
  });

  assert.equal(stageResult.status, "completed", JSON.stringify(stageResult));
  assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "ready_for_test");
});

test("frozen production scope advances Web and three configured Apps to exact aggregate live", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const manifest = {
    versionId: "version-production-e2e",
    candidateCommit: CANDIDATE_COMMIT,
    checksum: "manifest-production-e2e",
    artifactIdentity: CANDIDATE_ARTIFACT,
  };
  const apps = [
    ["au", "0000000001", "online.365english.app"],
    ["cn", "0000000002", "online.365english.china"],
    ["nz", "0000000003", "online.365english.nz"],
  ].map(([id, appStoreAppId, bundleId]) => ({
    id, name: id.toUpperCase(), enabled: true, appStoreAppId, bundleId,
    scheme: `E365${id.toUpperCase()}`, testScheme: `E365${id.toUpperCase()}Tests`,
    testTarget: `E365${id.toUpperCase()}Tests`, testFlightGroup: `Internal ${id.toUpperCase()}`,
    buildNumberSource: "app-store-connect", releaseMode: "automatic",
    reviewConfigurationRef: `app-store-review/${id}`, marketingVersion: "1.2.3",
  }));
  const effects = [];
  const live = new Set();
  const submission = (app) => {
    const values = {
      externalRequestId: `${app.id}-request`, buildNumber: `${apps.indexOf(app) + 101}`,
      uploadId: `${app.id}-upload`, processingId: `${app.id}-processing`,
      reviewSubmissionId: `${app.id}-submission`, processingStatus: "processed",
      reviewStatus: "submitted", releaseStatus: "not_released", liveStatus: "not_live",
    };
    return { ...values, lineage: { ...values }, observedEvidence: { appId: app.id } };
  };
  const iosAdapter = {
    release: async ({ app, recordStage }) => {
      effects.push(`release:${app.id}`);
      const values = submission(app);
      for (const stage of ["test", "archive", "upload", "processing", "review_submit", "review_wait"]) {
        await recordStage(stage, values);
      }
      return values;
    },
    readback: async ({ app, submission: persisted, recordStage }) => {
      effects.push(`readback:${app.id}`);
      await recordStage(live.has(app.id) ? "live_readback" : "review_wait", persisted);
      const base = submission(app);
      if (!live.has(app.id)) return {
        ...base, status: "waiting_external", authoritative: true, submissionExists: true,
      };
      const terminal = {
        ...base, status: "completed", authoritative: true, reviewStatus: "approved",
        reviewId: `${app.id}-review`, releaseStatus: "released", releaseId: `${app.id}-release-id`,
        liveStatus: "live", liveId: `${app.id}-live`, liveMarketingVersion: app.marketingVersion,
        liveBuildNumber: base.buildNumber, liveMembershipConfirmed: true,
      };
      terminal.lineage = {
        ...base.lineage, reviewId: terminal.reviewId, releaseId: terminal.releaseId, liveId: terminal.liveId,
      };
      terminal.liveEvidence = {
        appStoreAppId: app.appStoreAppId, marketingVersion: app.marketingVersion,
        buildNumber: base.buildNumber, liveId: terminal.liveId, membershipConfirmed: true,
      };
      return terminal;
    },
  };
  let webPublished = false;
  const webAdapter = {
    release: async () => {
      effects.push("release:web");
      webPublished = true;
      return { externalRequestId: "web-request", artifactIdentity: CANDIDATE_ARTIFACT, productionReleaseId: "web-release", observedEvidence: { upload: "ok" } };
    },
    readback: async () => ({
      confirmed: true, published: webPublished, status: "published", authoritative: true,
      candidateCommit: CANDIDATE_COMMIT, artifactIdentity: CANDIDATE_ARTIFACT,
      externalRequestId: "web-request", productionReleaseId: "web-release", healthStatus: "healthy",
      readbackStatus: "confirmed", observedEvidence: { release: "web-release" }, readbackEvidence: { sha: CANDIDATE_COMMIT },
    }),
  };
  const execute = () => executeProductionRelease({
    db: harness.db, manifest,
    platforms: [{ id: "task-production-e2e", platforms: ["web", "ios"] }],
    apps, webAdapter, iosAdapter,
    lease: { holder: "production-e2e", durationMs: 60_000, now: () => NOW }, now: NOW,
  });

  assert.equal((await execute()).status, "waiting_external");
  live.add("au");
  assert.equal((await execute()).status, "waiting_external");
  live.add("cn");
  assert.equal((await execute()).status, "waiting_external");
  live.add("nz");
  const completed = await execute();
  assert.equal(completed.status, "completed");
  assert.equal(completed.publication.published, true);
  assert.deepEqual(effects.filter((effect) => effect.startsWith("release:")), [
    "release:web", "release:au", "release:cn", "release:nz",
  ]);
  assert.deepEqual(completed.targets.map(({ platform, appId, status }) => [platform, appId, status]), [
    ["web", "", "succeeded"], ["ios", "au", "succeeded"],
    ["ios", "cn", "succeeded"], ["ios", "nz", "succeeded"],
  ]);
});

test("dashboard confirmation reaches frozen all-App publication and compensates partial cleanup", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  await harness.db.exec(`
    DELETE FROM release_manifests WHERE version_id = 'version-1';
    DELETE FROM orchestration_events WHERE id = 'evt-3';
    UPDATE orchestration_events SET hash = '${"a".repeat(64)}' WHERE id = 'evt-1';
    UPDATE orchestration_events SET previous_hash = NULL, hash = '${"b".repeat(64)}' WHERE id = 'evt-2';
  `);
  const taskRow = await harness.db.prepare(
    "SELECT snapshot FROM clickup_snapshots WHERE object_type = 'task' AND object_id = 'task-1'",
  ).first();
  const taskSnapshot = { ...JSON.parse(taskRow.snapshot), platforms: ["web", "ios"] };
  await harness.db.prepare(
    "UPDATE clickup_snapshots SET snapshot = ? WHERE object_type = 'task' AND object_id = 'task-1'",
  ).bind(JSON.stringify(taskSnapshot)).run();

  const apps = [
    ["au", "0000000001", "online.365english.app"],
    ["cn", "0000000002", "online.365english.china"],
    ["nz", "0000000003", "online.365english.nz"],
  ].map(([id, appStoreAppId, bundleId]) => ({
    id, name: id.toUpperCase(), enabled: true, appStoreAppId, bundleId,
    scheme: `E365${id.toUpperCase()}`, testScheme: `E365${id.toUpperCase()}Tests`,
    testTarget: `E365${id.toUpperCase()}Tests`, testFlightGroup: `Internal ${id.toUpperCase()}`,
    buildNumberSource: "app-store-connect", releaseMode: "automatic",
    reviewConfigurationRef: `app-store-review/${id}`,
  }));

  const secret = "production-e2e-secret";
  const dashboard = await startDashboardServer({
    db: harness.db, port: 0, mutationSecret: secret,
    versionStatusMap: { 发布中: "releasing" }, productionReadiness: { ready: true }, productionTargetApps: apps,
  });
  t.after(() => dashboard.close());
  const beforePublish = await fetch(`http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/version-1`);
  const beforePublishBody = await beforePublish.json();
  assert.equal(beforePublishBody.releaseReadiness.ready, true, JSON.stringify(beforePublishBody.releaseReadiness));
  for (let click = 0; click < 2; click += 1) {
    const response = await fetch(
      `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/version-1/publish`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "x-orchestration-actor-roles": '["release_manager"]' },
        body: JSON.stringify({ confirmationVersion: "1.0.1", requestId: "production-e2e-request" }),
      },
    );
    const responseBody = await response.json();
    assert.equal(response.status, 200, `click ${click}: ${JSON.stringify(responseBody)}`);
  }
  assert.equal((await harness.db.prepare(
    "SELECT COUNT(*) AS count FROM outbox_mutations WHERE object_id = 'version-1'",
  ).first()).count, 1);
  let remoteVersionStatus = "进行中";
  await flushOutbox(harness.db, {
    getTask: async () => ({ status: { status: remoteVersionStatus } }),
    updateTaskStatus: async (_id, status) => { remoteVersionStatus = status; },
  }, { now: NOW, config: CONFIG });
  assert.equal(remoteVersionStatus, "发布中");
  const pollEnv = await makeEnv(
    harness,
    () => ({ ...makeClickUpTask(), id: "task-1", name: "任务一", status: { status: "待发布" }, custom_fields: [
      { id: "field-managed", name: "自动化纳管", value: true },
      { id: "field-version", name: "目标版本", value: "1.0.1" },
      { id: "field-platforms", name: "影响平台", value: ["platform-web", "platform-ios"], type_config: { options: [
        { id: "platform-web", label: "Web" }, { id: "platform-ios", label: "iOS" },
      ] } },
    ] }),
    () => [],
    () => null,
    () => ({ id: "version-1", name: "1.0.1", status: { status: remoteVersionStatus } }),
  );
  const releasePoll = await pollClickUpOnce(pollEnv, { now: NOW });
  const releasingSnapshot = await loadLastConfirmed(harness.db, "version", "version-1");
  assert.equal(releasingSnapshot.status, "releasing", JSON.stringify(releasePoll));

  const live = new Set();
  const effects = [];
  const iosSubmission = (app) => {
    const values = {
      externalRequestId: `${app.id}-request`, buildNumber: `${apps.indexOf(app) + 201}`,
      uploadId: `${app.id}-upload`, processingId: `${app.id}-processing`,
      reviewSubmissionId: `${app.id}-submission`, processingStatus: "processed",
      reviewStatus: "submitted", releaseStatus: "not_released", liveStatus: "not_live",
    };
    return { ...values, lineage: { ...values }, observedEvidence: { appId: app.id } };
  };
  const iosAdapter = {
    release: async ({ app, recordStage }) => {
      effects.push(`release:${app.id}`);
      const values = iosSubmission(app);
      for (const stage of ["test", "archive", "upload", "processing", "review_submit", "review_wait"]) await recordStage(stage, values);
      return values;
    },
    readback: async ({ app, submission, recordStage }) => {
      await recordStage(live.has(app.id) ? "live_readback" : "review_wait", submission);
      const base = iosSubmission(app);
      if (!live.has(app.id)) return { ...base, status: "waiting_external", authoritative: true, submissionExists: true };
      const terminal = {
        ...base, status: "completed", authoritative: true, reviewStatus: "approved", reviewId: `${app.id}-review`,
        releaseStatus: "released", releaseId: `${app.id}-release-id`, liveStatus: "live", liveId: `${app.id}-live`,
        liveMarketingVersion: "1.0.1", liveBuildNumber: base.buildNumber, liveMembershipConfirmed: true,
      };
      terminal.lineage = { ...base.lineage, reviewId: terminal.reviewId, releaseId: terminal.releaseId, liveId: terminal.liveId };
      terminal.liveEvidence = { appStoreAppId: app.appStoreAppId, marketingVersion: "1.0.1", buildNumber: base.buildNumber, liveId: terminal.liveId, membershipConfirmed: true };
      return terminal;
    },
  };
  let webLive = false;
  const adapter = {
    collectRegressionEvidence: async () => ({ passed: true, command: "node --test" }),
    identifyArtifact: async () => CANDIDATE_ARTIFACT,
    release: async () => {
      effects.push("release:web"); webLive = true;
      return { externalRequestId: "web-request", artifactIdentity: CANDIDATE_ARTIFACT, productionReleaseId: "web-release", observedEvidence: { upload: "ok" } };
    },
    readback: async () => ({ confirmed: true, published: webLive, status: "published", authoritative: true,
      candidateCommit: CANDIDATE_COMMIT, artifactIdentity: CANDIDATE_ARTIFACT, externalRequestId: "web-request",
      productionReleaseId: "web-release", healthStatus: "healthy", readbackStatus: "confirmed",
      observedEvidence: { release: "web-release" }, readbackEvidence: { sha: CANDIDATE_COMMIT } }),
  };
  let cleanupFailure = true;
  const cleanup = [];
  const common = {
    snapshot: releasingSnapshot, now: NOW,
    db: harness.db, adapter, iosAdapter, apps,
    releaseLease: { holder: "production-e2e", durationMs: 60_000, now: () => NOW },
    productionReadiness: { ready: true }, client: { postComment: async () => ({}) },
    runtime: { repoPath: "/repo", worktreesRoot: "/worktrees" }, repository: "owner/repo",
    releaseGitOps: {
      integrateTaskPr: async () => ({ merged: true, versionBranch: "version/1.0.1", taskHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", candidateCommit: CANDIDATE_COMMIT, headRefName: "task/task-1", prNumber: 1, repository: "owner/repo" }),
      persistCandidate: async () => ({ persisted: true, candidateRef: `refs/heads/release-candidate/version-1/${CANDIDATE_COMMIT}` }),
      verifyCandidate: async () => ({ verified: true }),
    },
    services: {
      closeTaskPullRequest: async () => cleanup.push("close"),
      deleteRemoteTaskBranch: async () => { cleanup.push("remote"); if (cleanupFailure) { cleanupFailure = false; throw new Error("temporary cleanup failure"); } },
      removeTaskWorktree: async () => cleanup.push("local"),
    },
  };

  const initialRelease = await coordinateReleaseSnapshot(common);
  assert.equal(initialRelease.status, "waiting_external", JSON.stringify(initialRelease));
  for (const app of apps) {
    live.add(app.id);
    const result = await coordinateReleaseSnapshot(common);
    if (app !== apps.at(-1)) assert.equal(result.status, "waiting_external");
    else assert.equal(result.status, "succeeded");
  }
  assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "published");
  assert.equal((await loadAggregate(harness.db, "task", "task-1")).state, "published");
  assert.deepEqual(effects.filter((value) => value.startsWith("release:")), ["release:web", "release:au", "release:cn", "release:nz"]);
  assert.deepEqual(cleanup, ["close", "remote"]);

  const retried = await coordinateReleaseSnapshot({ ...common, snapshot: { ...common.snapshot, status: "published" } });
  assert.equal(retried.status, "succeeded");
  assert.deepEqual(cleanup, ["close", "remote", "remote", "local"]);
});

test("production target order short-circuits first-App failure and records second-App review rejection after Web", async (t) => {
  const apps = ["au", "cn"].map((id, index) => ({
    id, name: id, enabled: true, appStoreAppId: `000000000${index + 1}`,
    bundleId: `online.365english.${id}`, scheme: `E365${id.toUpperCase()}`,
    testScheme: `E365${id.toUpperCase()}Tests`, testTarget: `E365${id.toUpperCase()}Tests`,
    testFlightGroup: `Internal ${id}`, buildNumberSource: "app-store-connect",
    releaseMode: "automatic", reviewConfigurationRef: `app-store-review/${id}`,
    marketingVersion: "1.2.3",
  }));
  const webAdapter = {
    release: async () => ({ externalRequestId: "web-request", artifactIdentity: CANDIDATE_ARTIFACT, productionReleaseId: "web-release", observedEvidence: { ok: true } }),
    readback: async () => ({ confirmed: true, published: true, status: "published", authoritative: true,
      candidateCommit: CANDIDATE_COMMIT, artifactIdentity: CANDIDATE_ARTIFACT, externalRequestId: "web-request",
      productionReleaseId: "web-release", healthStatus: "healthy", readbackStatus: "confirmed",
      observedEvidence: { ok: true }, readbackEvidence: { ok: true } }),
  };
  const submission = (app) => {
    const base = { externalRequestId: `${app.id}-request`, buildNumber: "301", uploadId: `${app.id}-upload`, processingId: `${app.id}-processing`, reviewSubmissionId: `${app.id}-submission` };
    return { ...base, processingStatus: "processed", reviewStatus: "submitted", lineage: base, observedEvidence: { appId: app.id } };
  };
  const executeCase = async ({ versionId, failApp, rejectApp }) => {
    const harness = await createCloudWorkerHarness();
    t.after(() => harness.dispose());
    const calls = [];
    const iosAdapter = {
      release: async ({ app, recordStage }) => {
        calls.push(`release:${app.id}`);
        if (app.id === failApp) {
          const error = new Error("deterministic App failure");
          error.deterministic = true; error.failureClassification = "validation";
          throw error;
        }
        const value = submission(app);
        for (const stage of ["test", "archive", "upload", "processing", "review_submit", "review_wait"]) await recordStage(stage, value);
        return value;
      },
      readback: async ({ app, submission: persisted, recordStage }) => {
        calls.push(`readback:${app.id}`);
        await recordStage("review_wait", persisted);
        if (app.id === rejectApp) return { ...submission(app), status: "waiting_external", authoritative: true, submissionExists: true, reviewStatus: "rejected" };
        const base = submission(app);
        const terminal = { ...base, status: "completed", authoritative: true, reviewStatus: "approved", reviewId: `${app.id}-review`, releaseStatus: "released", releaseId: `${app.id}-release`, liveStatus: "live", liveId: `${app.id}-live`, liveMarketingVersion: "1.2.3", liveBuildNumber: base.buildNumber, liveMembershipConfirmed: true };
        terminal.lineage = { ...base.lineage, reviewId: terminal.reviewId, releaseId: terminal.releaseId, liveId: terminal.liveId };
        terminal.liveEvidence = { appStoreAppId: app.appStoreAppId, marketingVersion: "1.2.3", buildNumber: base.buildNumber, liveId: terminal.liveId, membershipConfirmed: true };
        return terminal;
      },
    };
    const result = await executeProductionRelease({
      db: harness.db, manifest: { versionId, candidateCommit: CANDIDATE_COMMIT, checksum: `manifest-${versionId}`, artifactIdentity: CANDIDATE_ARTIFACT },
      platforms: [{ id: "task", platforms: ["web", "ios"] }], apps, webAdapter, iosAdapter,
      lease: { holder: versionId, durationMs: 60_000, now: () => NOW }, now: NOW,
    });
    return { result, calls };
  };

  const first = await executeCase({ versionId: "v-first-app-fails", failApp: "au" });
  assert.equal(first.result.status, "failed");
  assert.deepEqual(first.calls, ["release:au"]);

  const second = await executeCase({ versionId: "v-second-app-rejected", rejectApp: "cn" });
  assert.equal(second.result.status, "failed");
  assert.deepEqual(second.calls, ["release:au", "readback:au", "release:cn", "readback:cn"]);
  assert.equal(second.result.targets.find((target) => target.platform === "web").status, "succeeded");
  assert.equal(second.result.targets.find((target) => target.appId === "au").status, "succeeded");
  assert.equal(second.result.targets.find((target) => target.appId === "cn").failureClassification, "product_rework");
  assert.equal(second.result.publication, undefined);
});

test("production recovery uses GET after restart, fences takeover, and blocks mini-program", async (t) => {
  await t.test("unknown POST outcome is reconciled by a reconstructed adapter without another POST", async (t) => {
    const harness = await createCloudWorkerHarness();
    t.after(() => harness.dispose());
    const manifest = {
      versionId: "v-restart-reconcile", candidateCommit: CANDIDATE_COMMIT,
      checksum: "manifest-restart-reconcile", artifactIdentity: CANDIDATE_ARTIFACT,
    };
    let postCalls = 0;
    const first = await executeProductionRelease({
      db: harness.db, manifest, platforms: [{ id: "task-restart", platforms: ["web"] }], apps: [],
      webAdapter: {
        release: async () => { postCalls += 1; throw new Error("connection reset after production switch"); },
        readback: async () => { throw new Error("first worker must not reconcile its own unknown POST"); },
      },
      iosAdapter: null, lease: { holder: "worker-before-restart", durationMs: 60_000, now: () => NOW }, now: NOW,
    });
    assert.equal(first.status, "waiting_external");

    let getCalls = 0;
    const afterRestart = await executeProductionRelease({
      db: harness.db, manifest, platforms: [{ id: "task-restart", platforms: ["web"] }], apps: [],
      webAdapter: {
        release: async () => { throw new Error("restart must not repeat production POST"); },
        readback: async () => {
          getCalls += 1;
          return {
            confirmed: true, published: true, status: "published", authoritative: true,
            candidateCommit: CANDIDATE_COMMIT, artifactIdentity: CANDIDATE_ARTIFACT,
            externalRequestId: "web-request-recovered", productionReleaseId: "web-release-recovered",
            healthStatus: "healthy", readbackStatus: "confirmed",
            observedEvidence: { source: "authoritative-get" }, readbackEvidence: { recovered: true },
          };
        },
      },
      iosAdapter: null,
      lease: { holder: "worker-after-restart", durationMs: 60_000, now: () => "2026-08-04T00:12:00.000Z" },
      now: "2026-08-04T00:12:00.000Z",
    });
    assert.equal(afterRestart.status, "completed");
    assert.equal(postCalls, 1);
    assert.equal(getCalls, 1);
  });

  await t.test("lease takeover fences every later external effect", async (t) => {
    const harness = await createCloudWorkerHarness();
    t.after(() => harness.dispose());
    const manifest = {
      versionId: "v-fencing-e2e", candidateCommit: CANDIDATE_COMMIT,
      checksum: "manifest-fencing-e2e", artifactIdentity: CANDIDATE_ARTIFACT,
    };
    const calls = [];
    const result = await executeProductionRelease({
      db: harness.db, manifest,
      platforms: [{ id: "task-fencing", platforms: ["web", "ios"] }],
      apps: [{
        id: "au", name: "AU", enabled: true, appStoreAppId: "0000000001", bundleId: "online.365english.app",
        scheme: "E365AU", testScheme: "E365AUTests", testTarget: "E365AUTests", testFlightGroup: "Internal AU",
        buildNumberSource: "app-store-connect", releaseMode: "automatic", reviewConfigurationRef: "app-store-review/au",
        marketingVersion: "1.2.3",
      }],
      webAdapter: {
        release: async () => {
          calls.push("web:release");
          await harness.db.prepare(
            `UPDATE orchestration_leases SET holder = 'takeover-worker', fencing_token = fencing_token + 1,
             expires_at = '2026-08-04T01:00:00.000Z' WHERE aggregate_type = 'version' AND aggregate_id = ?`,
          ).bind(manifest.versionId).run();
          return { externalRequestId: "web-request", artifactIdentity: CANDIDATE_ARTIFACT, productionReleaseId: "web-release", observedEvidence: { ok: true } };
        },
        readback: async () => calls.push("web:readback"),
      },
      iosAdapter: {
        release: async () => calls.push("ios:release"),
        readback: async () => calls.push("ios:readback"),
      },
      lease: { holder: "original-worker", durationMs: 60_000, now: () => NOW }, now: NOW,
    });
    assert.equal(result.status, "waiting_external");
    assert.deepEqual(calls, ["web:release"]);
  });

  await t.test("restart during iOS review wait performs readback only with exact persisted lineage", async (t) => {
    const harness = await createCloudWorkerHarness();
    t.after(() => harness.dispose());
    const manifest = {
      versionId: "v-ios-review-restart", candidateCommit: CANDIDATE_COMMIT,
      checksum: "manifest-ios-review-restart", artifactIdentity: CANDIDATE_ARTIFACT,
    };
    const app = {
      id: "au", name: "AU", enabled: true, appStoreAppId: "0000000001", bundleId: "online.365english.app",
      scheme: "E365AU", testScheme: "E365AUTests", testTarget: "E365AUTests", testFlightGroup: "Internal AU",
      buildNumberSource: "app-store-connect", releaseMode: "automatic", reviewConfigurationRef: "app-store-review/au",
      marketingVersion: "1.2.3",
    };
    const base = {
      externalRequestId: "au-request", buildNumber: "401", uploadId: "au-upload",
      processingId: "au-processing", reviewSubmissionId: "au-submission",
      processingStatus: "processed", reviewStatus: "submitted", releaseStatus: "not_released", liveStatus: "not_live",
    };
    const submission = { ...base, lineage: { ...base }, observedEvidence: { phase: "review_wait" } };
    const beforeRestartCalls = [];
    const first = await executeProductionRelease({
      db: harness.db, manifest, platforms: [{ id: "task-ios-restart", platforms: ["ios"] }], apps: [app],
      webAdapter: null,
      iosAdapter: {
        release: async ({ recordStage }) => {
          beforeRestartCalls.push("upload-and-submit");
          for (const stage of ["test", "archive", "upload", "processing", "review_submit", "review_wait"]) await recordStage(stage, submission);
          return submission;
        },
        readback: async ({ submission: persisted, recordStage }) => {
          beforeRestartCalls.push("review-get");
          assert.equal(persisted.reviewSubmissionId, base.reviewSubmissionId);
          await recordStage("review_wait", persisted);
          return { ...submission, status: "waiting_external", authoritative: true, submissionExists: true };
        },
      },
      lease: { holder: "ios-worker-before-restart", durationMs: 60_000, now: () => NOW }, now: NOW,
    });
    assert.equal(first.status, "waiting_external");
    assert.deepEqual(beforeRestartCalls, ["upload-and-submit", "review-get"]);

    const afterRestartCalls = [];
    const second = await executeProductionRelease({
      db: harness.db, manifest, platforms: [{ id: "task-ios-restart", platforms: ["ios"] }], apps: [app],
      webAdapter: null,
      iosAdapter: {
        release: async () => { afterRestartCalls.push("unexpected-upload-or-submit"); throw new Error("must not repeat submission"); },
        readback: async ({ submission: persisted, recordStage }) => {
          afterRestartCalls.push("review-get");
          assert.equal(persisted.externalRequestId, base.externalRequestId);
          assert.equal(persisted.buildNumber, base.buildNumber);
          assert.equal(persisted.uploadId, base.uploadId);
          assert.equal(persisted.reviewSubmissionId, base.reviewSubmissionId);
          const terminal = {
            ...submission, status: "completed", authoritative: true, reviewStatus: "approved", reviewId: "au-review",
            releaseStatus: "released", releaseId: "au-release", liveStatus: "live", liveId: "au-live",
            liveMarketingVersion: "1.2.3", liveBuildNumber: base.buildNumber, liveMembershipConfirmed: true,
          };
          terminal.lineage = { ...base, reviewId: terminal.reviewId, releaseId: terminal.releaseId, liveId: terminal.liveId };
          terminal.liveEvidence = { appStoreAppId: app.appStoreAppId, marketingVersion: "1.2.3", buildNumber: base.buildNumber, liveId: terminal.liveId, membershipConfirmed: true };
          await recordStage("live_readback", submission);
          return terminal;
        },
      },
      lease: { holder: "ios-worker-after-restart", durationMs: 60_000, now: () => "2026-08-04T00:12:00.000Z" },
      now: "2026-08-04T00:12:00.000Z",
    });
    assert.equal(second.status, "completed", JSON.stringify(second));
    assert.deepEqual(afterRestartCalls, ["review-get"]);
  });

  await t.test("mini-program is rejected before persistence or adapter side effects", async (t) => {
    const harness = await createCloudWorkerHarness();
    t.after(() => harness.dispose());
    const calls = [];
    await assert.rejects(executeProductionRelease({
      db: harness.db,
      manifest: { versionId: "v-mini-program", candidateCommit: CANDIDATE_COMMIT, checksum: "manifest-mini-program", artifactIdentity: CANDIDATE_ARTIFACT },
      platforms: [{ id: "task-mini", platforms: ["mini-program"] }], apps: [],
      webAdapter: { release: async () => calls.push("release"), readback: async () => calls.push("readback") },
      iosAdapter: null, lease: { holder: "mini-worker", durationMs: 60_000, now: () => NOW }, now: NOW,
    }), (error) => error?.code === "UNSUPPORTED_PRODUCTION_PLATFORM");
    assert.deepEqual(calls, []);
    for (const table of ["production_release_attempts", "production_release_targets"]) {
      assert.equal((await harness.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count, 0);
    }
  });
});

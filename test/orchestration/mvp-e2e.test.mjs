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
import { createWebAdapter } from "../../orchestration/release/adapters/web.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { loadManifest } from "../../orchestration/release/version-aggregator.mjs";
import { createDomainEvent } from "../../orchestration/domain/events.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { appendCommandResult } from "../../orchestration/persistence/d1-event-store.mjs";
import { saveSnapshot } from "../../orchestration/clickup/snapshot.mjs";

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
      getVersionsByList: async () => [
        { id: "version-e2e-1", name: "version-e2e-1", status: { status: "进行中" } },
      ],
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

async function seedInfrastructureRejectedTask(harness, taskId) {
  const types = [
    "start_analysis",
    "analysis_completed",
    "start_development",
    "development_completed",
    "acceptance_rejected",
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
        parameters: type === "acceptance_rejected"
          ? { evidenceId: `staging-${taskId}-stage_task-4` }
          : {},
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
      if (prompt.includes("研发分析器")) {
        return { exitCode: 0, stdout: JSON.stringify({
          scope: "实现录音回放按钮",
          acceptance_criteria: [{ id: "ac-1", criterion: "按钮可点击", verification: "手动测试" }],
          risks: [],
          open_questions: [],
        }), stderr: "" };
      }
      if (prompt.includes("验收器")) {
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
    }),
    switchEntry: async ({ candidateCommit, artifactIdentity }) => {
      publishedDeployment = {
        confirmed: true,
        published: true,
        candidateCommit,
        artifactIdentity: structuredClone(artifactIdentity),
        url: "https://e365.example.com",
      };
      return { url: publishedDeployment.url };
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

test("explicit infrastructure recovery resumes staging and reaches ready for test", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const taskId = "task-e2e-1";
  await seedInfrastructureRejectedTask(harness, taskId);
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
  await harness.db.prepare(
    `INSERT INTO staging_deployments (
       id, task_id, target_version, pr_url, task_commit, candidate_commit,
       version_branch, stage, status, attempt, error, started_at, completed_at,
       failure_owner, failure_classification, failure_fingerprint
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'deploy', 'failed', 1, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `${taskId}-staging-1`,
    taskId,
    persistedPayload.targetVersion,
    persistedPayload.pr.url,
    persistedPayload.commitSha,
    CANDIDATE_COMMIT,
    persistedPayload.versionBranch,
    "staging unavailable",
    NOW,
    NOW,
    "staging_infrastructure",
    "staging_infrastructure",
    "infra-fingerprint-e2e",
  ).run();
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

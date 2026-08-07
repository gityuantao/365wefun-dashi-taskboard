import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { executeDevelopment } from "../../orchestration/ai/developer.mjs";

const NOW = "2026-08-04T00:02:00.000Z";

async function setupTask(harness) {
  for (let index = 0; index < 2; index += 1) {
    const type = ["start_analysis", "analysis_completed"][index];
    const result = await dispatchCommand({
      db: harness.db,
      command: parseCommandEnvelope({
        id: `dev-seed-${index}`,
        type,
        aggregateType: "task",
        aggregateId: "task-1",
        expectedVersion: index + 1,
        actorId: "system-poller",
        issuedAt: NOW,
        reason: "seed",
        parameters: {},
      }),
      now: NOW,
    });
    assert.equal(result.status, "succeeded");
  }
}

const JOB = {
  id: "job-d1",
  commandId: "cmd-d1",
  jobType: "develop",
  payload: {
    taskId: "task-1",
    repoPath: "/tmp/repo",
    worktreesRoot: "/tmp/repo/.wt",
    baseRef: "main",
    versionBranch: "version/v-1",
    acceptanceCriteria: [{ id: "ac-1", criterion: "按钮可点击" }],
  },
};

function mockGitOps(overrides = {}) {
  return {
    createWorktree: async ({ taskId }) => ({
      worktreePath: `/tmp/wt/task-${taskId}`,
      branch: `task/${taskId}`,
    }),
    commitAll: async () => ({}),
    createPullRequest: async () => ({ url: "https://github.com/x/pull/1" }),
    ...overrides,
  };
}

function makeClient(overrides = {}) {
  return {
    getTask: async () => ({
      id: "task-1",
      name: "录音回放按钮",
      description: "修复录音回放",
    }),
    postComment: async () => ({}),
    updateCustomField: async () => ({}),
    getComments: async () => [],
    ...overrides,
  };
}

function validOutput() {
  return JSON.stringify({
    change_summary: "实现录音回放按钮",
    tests: [{ name: "test-1", passed: true }],
  });
}

test("development completes, creates a PR, and advances to ready for test", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const gitOps = mockGitOps();
  const result = await executeDevelopment({
    job: JOB,
    db: harness.db,
    client: makeClient(),
    codex: { run: async () => ({ exitCode: 0, stdout: validOutput(), stderr: "" }) },
    gitOps,
    now: NOW,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.pr.url, "https://github.com/x/pull/1");
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "accepting");
  assert.equal(aggregate.version, 4);
});

test("stale develop job does not restart a parked task", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  for (const [type, version] of [
    ["start_development", 3],
    ["development_needs_info", 4],
  ]) {
    await dispatchCommand({
      db: harness.db,
      command: parseCommandEnvelope({
        id: `stale-${type}-${version}`,
        type,
        aggregateType: "task",
        aggregateId: "task-1",
        expectedVersion: version,
        actorId: "system",
        issuedAt: NOW,
        reason: "seed",
        parameters: {},
      }),
      now: NOW,
    });
  }
  const result = await executeDevelopment({
    job: JOB,
    db: harness.db,
    client: makeClient(),
    codex: { run: async () => ({ exitCode: 0, stdout: validOutput(), stderr: "" }) },
    gitOps: mockGitOps(),
    now: NOW,
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /stale develop job/);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "waiting_info");
});

test("development that cannot reproduce parks the task in waiting_info", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const calls = [];
  const client = makeClient({
    postComment: async (id, body) => calls.push(["comment", id, body]),
  });
  const result = await executeDevelopment({
    job: JOB,
    db: harness.db,
    client,
    codex: {
      run: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ needs_info: true, reason: "线上音频实测正常，无法复现静音问题" }),
        stderr: "",
      }),
    },
    gitOps: mockGitOps(),
    now: NOW,
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /needs_info/);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "waiting_info");
  assert.ok(
    calls.some(([, , body]) => String(body).includes("开发无法完成")),
    "should post a comment asking for more info",
  );
});

test("development passes the 影响平台 field into the prompt", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  let prompt = "";
  const result = await executeDevelopment({
    job: JOB,
    db: harness.db,
    client: makeClient({
      getTask: async () => ({
        id: "task-1",
        name: "录音回放按钮",
        description: "修复录音回放",
        status: { status: "开发中" },
        custom_fields: [
          { id: "field-version", name: "目标版本", value: "version-9" },
          { id: "field-platforms", name: "影响平台", value: ["小程序", "安卓"] },
        ],
      }),
    }),
    codex: {
      run: async ({ prompt: p }) => { prompt = p; return { exitCode: 0, stdout: validOutput(), stderr: "" }; },
    },
    gitOps: mockGitOps(),
    now: NOW,
  });
  assert.equal(result.status, "completed");
  assert.match(prompt, /影响平台（ClickUp 字段）：小程序、安卓/);
});

test("development failure leaves the task in ready for development", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const result = await executeDevelopment({
    job: JOB,
    db: harness.db,
    client: makeClient(),
    codex: { run: async () => ({ exitCode: 2, stdout: "", stderr: "build failed" }) },
    gitOps: mockGitOps(),
    now: NOW,
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /build failed/);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_development");
});

test("development worktree failure is reported without advancing", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const result = await executeDevelopment({
    job: JOB,
    db: harness.db,
    client: makeClient(),
    codex: { run: async () => ({ exitCode: 0, stdout: validOutput(), stderr: "" }) },
    gitOps: mockGitOps({
      createWorktree: async () => { throw new Error("disk full"); },
    }),
    now: NOW,
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /disk full/);
});

test("development stores the PR as evidence without a premature comment", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const calls = [];
  const client = makeClient({
    postComment: async (id, body) => calls.push(["comment", id, body]),
    updateCustomField: async (id, field, value) => calls.push(["field", id, field, value]),
  });
  await executeDevelopment({
    job: JOB,
    db: harness.db,
    client,
    codex: { run: async () => ({ exitCode: 0, stdout: validOutput(), stderr: "" }) },
    gitOps: mockGitOps(),
    now: NOW,
  });
  assert.ok(calls.some(([kind, , field]) => kind === "field" && field === "field-evidence"));
  assert.equal(calls.some(([kind, , body]) => kind === "comment" && String(body).includes("pull/1")), false);
});

test("development reads comments and includes acceptance feedback in the prompt", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  let prompt = "";
  const result = await executeDevelopment({
    job: JOB,
    db: harness.db,
    client: makeClient({
      getTask: async () => ({
        id: "task-1",
        name: "录音回放按钮",
        description: "修复录音回放",
        status: { status: "开发中" },
        custom_fields: [
          { id: "field-version", name: "目标版本", value: "version-9" },
          {
            id: "field-acceptance-feedback",
            name: "验收反馈",
            value: "完整验收失败详情：按钮无法点击",
          },
        ],
      }),
      getComments: async () => [
        { id: "c1", comment_text: "❌ 验收不通过：按钮无法点击，已退回待开发。" },
        { id: "c2", comment_text: "需求补充：点击后需要跳转" },
      ],
    }),
    codex: { run: async ({ prompt: p }) => { prompt = p; return { exitCode: 0, stdout: validOutput(), stderr: "" }; } },
    gitOps: mockGitOps(),
    now: NOW,
  });
  assert.equal(result.status, "completed");
  assert.match(prompt, /验收不通过：按钮无法点击/);
  assert.match(prompt, /需求补充：点击后需要跳转/);
  assert.match(prompt, /完整验收失败详情：按钮无法点击/);
});

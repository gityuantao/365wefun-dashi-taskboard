import assert from "node:assert/strict";
import { access, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { VALID_PNG } from "../helpers/image-fixtures.mjs";
import { executeDevelopment } from "../../orchestration/ai/developer.mjs";

const NOW = "2026-08-04T00:02:00.000Z";
const PNG = VALID_PNG;
const CORRUPT_IMAGE = Uint8Array.from([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]);

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
    aggregateVersion: 2,
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

async function commentMediaDirectories() {
  return new Set((await readdir(tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("taskboard-clickup-images-"))
    .map((entry) => entry.name));
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

test("parked development exits before reading ClickUp or creating a worktree", async (t) => {
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
        id: `preflight-${type}-${version}`,
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
  const calls = [];

  const result = await executeDevelopment({
    job: JOB,
    db: harness.db,
    client: makeClient({
      getTask: async () => { calls.push("getTask"); throw new Error("must not read task"); },
      getComments: async () => { calls.push("getComments"); return []; },
    }),
    codex: { run: async () => { calls.push("codex"); return { exitCode: 0, stdout: validOutput(), stderr: "" }; } },
    gitOps: mockGitOps({
      createWorktree: async () => { calls.push("createWorktree"); throw new Error("must not create worktree"); },
    }),
    now: NOW,
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /stale develop job/);
  assert.deepEqual(calls, []);
});

test("manual pause during Codex run prevents commit PR evidence and completion", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  await dispatchCommand({
    db: harness.db,
    command: parseCommandEnvelope({
      id: "pause-during-run-start",
      type: "start_development",
      aggregateType: "task",
      aggregateId: "task-1",
      expectedVersion: 3,
      actorId: "system",
      issuedAt: NOW,
      reason: "seed",
      parameters: {},
    }),
    now: NOW,
  });
  const sideEffects = [];

  const result = await executeDevelopment({
    job: JOB,
    db: harness.db,
    client: makeClient({
      updateCustomField: async () => sideEffects.push("evidence"),
    }),
    codex: {
      run: async () => {
        await dispatchCommand({
          db: harness.db,
          command: parseCommandEnvelope({
            id: "manual-pause-during-codex",
            type: "development_needs_info",
            aggregateType: "task",
            aggregateId: "task-1",
            expectedVersion: 4,
            actorId: "system-poller",
            issuedAt: NOW,
            reason: "user moved task to waiting_info",
            parameters: {},
          }),
          now: NOW,
        });
        return { exitCode: 0, stdout: validOutput(), stderr: "" };
      },
    },
    gitOps: mockGitOps({
      commitAll: async () => sideEffects.push("commit"),
      createPullRequest: async () => {
        sideEffects.push("pull-request");
        return { url: "https://github.com/x/pull/1" };
      },
    }),
    now: NOW,
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /stale develop job/);
  assert.equal(result.classification, "paused_waiting_info");
  assert.deepEqual(sideEffects, []);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "waiting_info");
  const completion = await harness.db
    .prepare("SELECT id FROM orchestration_events WHERE type = 'task.development_completed'")
    .first();
  assert.equal(completion, null);
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

test("development reloads stale state when its needs_info transition is not persisted", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  await dispatchCommand({
    db: harness.db,
    command: parseCommandEnvelope({
      id: "needs-info-dispatch-failure-start",
      type: "start_development",
      aggregateType: "task",
      aggregateId: "task-1",
      expectedVersion: 3,
      actorId: "system",
      issuedAt: NOW,
      reason: "seed",
      parameters: {},
    }),
    now: NOW,
  });
  const comments = [];
  const failingDb = {
    prepare: (sql) => harness.db.prepare(sql),
    batch: async () => {
      throw new Error("forced needs_info dispatch failure");
    },
  };

  const result = await executeDevelopment({
    job: JOB,
    db: failingDb,
    client: makeClient({
      postComment: async (_taskId, body) => comments.push(body),
    }),
    codex: {
      run: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ needs_info: true, reason: "需要更多复现信息" }),
        stderr: "",
      }),
    },
    gitOps: mockGitOps(),
    now: NOW,
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /stale develop job: task is in developing/);
  assert.equal(result.classification, undefined);
  assert.equal((await loadAggregate(harness.db, "task", "task-1")).state, "developing");
  assert.equal(comments.some((body) => String(body).includes("开发无法完成")), false);
});

test("needs_info comments redact common credential formats", async (t) => {
  const cases = [
    {
      name: "quoted JSON token",
      reason: '无法复现 {"token":"needs-info-json-secret"}',
      secret: "needs-info-json-secret",
    },
    {
      name: "Authorization Bearer",
      reason: "请求失败 Authorization: Bearer needs-info-bearer-secret",
      secret: "needs-info-bearer-secret",
    },
    {
      name: "Authorization Basic",
      reason: "请求失败 Authorization: Basic bmVlZHMtaW5mby1iYXNpYw==",
      secret: "bmVlZHMtaW5mby1iYXNpYw==",
    },
  ];

  for (const credentialCase of cases) {
    await t.test(credentialCase.name, async (subtest) => {
      const harness = await createCloudWorkerHarness();
      subtest.after(() => harness.dispose());
      await setupTask(harness);
      const comments = [];
      await executeDevelopment({
        job: JOB,
        db: harness.db,
        client: makeClient({
          postComment: async (_taskId, body) => comments.push(body),
        }),
        codex: {
          run: async () => ({
            exitCode: 0,
            stdout: JSON.stringify({ needs_info: true, reason: credentialCase.reason }),
            stderr: "",
          }),
        },
        gitOps: mockGitOps(),
        now: NOW,
      });

      const needsInfoComment = comments.find((body) => String(body).includes("开发无法完成"));
      assert.ok(needsInfoComment);
      assert.match(needsInfoComment, /\[REDACTED\]/);
      assert.equal(String(needsInfoComment).includes(credentialCase.secret), false);
    });
  }
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

test("unexpected development failure posts a short redacted diagnostic after rollback", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const comments = [];
  const result = await executeDevelopment({
    job: JOB,
    db: harness.db,
    client: makeClient({
      postComment: async (_taskId, body) => comments.push(body),
    }),
    codex: { run: async () => ({ exitCode: 0, stdout: validOutput(), stderr: "" }) },
    gitOps: mockGitOps({
      commitAll: async () => {
        throw new Error("git commit failed token=super-secret-value");
      },
    }),
    now: NOW,
  });

  assert.equal(result.status, "failed");
  const failureComment = comments.find((body) => String(body).includes("开发失败"));
  assert.ok(failureComment, "rollback should leave a visible failure comment in ClickUp");
  assert.match(failureComment, /git commit failed/);
  assert.doesNotMatch(failureComment, /super-secret-value/);
});

test("rollback diagnostics redact common credential formats", async (t) => {
  const cases = [
    {
      name: "quoted JSON credentials",
      message: 'request failed: {"token":"json-token-secret","password":"json-password-secret"}',
      secrets: ["json-token-secret", "json-password-secret"],
    },
    {
      name: "quoted JSON Authorization bearer",
      message: 'request failed: {"Authorization":"Bearer json-bearer-secret"}',
      secrets: ["json-bearer-secret"],
    },
    {
      name: "Authorization Basic header",
      message: "request failed: Authorization: Basic dXNlcjpzdXBlci1zZWNyZXQ=",
      secrets: ["dXNlcjpzdXBlci1zZWNyZXQ="],
    },
    {
      name: "quoted API key assignment",
      message: "request failed: api_key='quoted-api-secret'",
      secrets: ["quoted-api-secret"],
    },
  ];

  for (const credentialCase of cases) {
    await t.test(credentialCase.name, async (subtest) => {
      const harness = await createCloudWorkerHarness();
      subtest.after(() => harness.dispose());
      await setupTask(harness);
      const comments = [];
      await executeDevelopment({
        job: JOB,
        db: harness.db,
        client: makeClient({
          postComment: async (_taskId, body) => comments.push(body),
        }),
        codex: { run: async () => ({ exitCode: 0, stdout: validOutput(), stderr: "" }) },
        gitOps: mockGitOps({
          commitAll: async () => {
            throw new Error(credentialCase.message);
          },
        }),
        now: NOW,
      });

      const failureComment = comments.find((body) => String(body).includes("开发失败"));
      assert.ok(failureComment);
      assert.match(failureComment, /\[REDACTED\]/);
      for (const secret of credentialCase.secrets) {
        assert.equal(String(failureComment).includes(secret), false);
      }
    });
  }
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

test("development sends comment images to Codex with their comment label and cleans them up", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  let options;
  let downloadedPath;
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
        {
          id: "c1",
          comment_text: "❌ 验收不通过：按钮无法点击，已退回待开发。",
          attachments: [{ title: "broken-button.png", url: "https://attachments.clickup.com/broken-button.png" }],
        },
        { id: "c2", comment_text: "需求补充：点击后需要跳转" },
      ],
      downloadAttachment: async () => ({
        body: PNG,
        contentType: "image/png",
        contentLength: PNG.byteLength,
      }),
    }),
    codex: {
      run: async (value) => {
        options = value;
        [downloadedPath] = value.imagePaths;
        await access(downloadedPath);
        return { exitCode: 0, stdout: validOutput(), stderr: "" };
      },
    },
    gitOps: mockGitOps(),
    now: NOW,
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(options.imagePaths, [downloadedPath]);
  assert.match(options.prompt, /验收不通过：按钮无法点击/);
  assert.match(options.prompt, /评论 c1 图片：broken-button\.png/);
  assert.match(options.prompt, /需求补充：点击后需要跳转/);
  assert.match(options.prompt, /完整验收失败详情：按钮无法点击/);
  await assert.rejects(access(downloadedPath));
});

test("development cleans comment media when feedback processing throws after collection", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const before = await commentMediaDirectories();
  let codexCalled = false;

  const result = await executeDevelopment({
    job: JOB,
    db: harness.db,
    client: makeClient({
      getTask: async () => ({
        id: "task-1",
        name: "录音回放按钮",
        description: "修复录音回放",
        custom_fields: [{
          id: "field-acceptance-feedback",
          name: "验收反馈",
          get value() {
            throw new Error("feedback extraction failed");
          },
        }],
      }),
      getComments: async () => [{
        id: "comment-cleanup-feedback-error",
        attachments: [{
          title: "feedback-error.png",
          url: "https://attachments.clickup.com/feedback-error.png",
        }],
      }],
      downloadAttachment: async () => ({
        body: PNG,
        contentType: "image/png",
        contentLength: PNG.byteLength,
      }),
    }),
    codex: { run: async () => { codexCalled = true; return { exitCode: 0, stdout: validOutput(), stderr: "" }; } },
    gitOps: mockGitOps(),
    now: NOW,
  });

  const after = await commentMediaDirectories();
  const created = [...after].filter((directory) => !before.has(directory));
  t.after(async () => {
    await Promise.all(created.map((directory) => rm(path.join(tmpdir(), directory), {
      recursive: true,
      force: true,
    })));
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /feedback extraction failed/);
  assert.equal(codexCalled, false);
  assert.deepEqual(created, []);
});

test("development waits for info when a selected comment image is corrupt", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const comments = [];
  let codexCalled = false;
  const result = await executeDevelopment({
    job: JOB,
    db: harness.db,
    client: makeClient({
      getComments: async () => [{
        id: "comment-corrupt-development",
        attachments: [{
          title: "development-evidence.png",
          url: "https://attachments.clickup.com/development-evidence.png?token=attachment-secret",
        }],
      }],
      downloadAttachment: async () => ({
        body: CORRUPT_IMAGE,
        contentType: "image/png",
        contentLength: CORRUPT_IMAGE.byteLength,
      }),
      postComment: async (_taskId, body) => comments.push(body),
    }),
    codex: { run: async () => { codexCalled = true; return { exitCode: 0, stdout: validOutput(), stderr: "" }; } },
    gitOps: mockGitOps(),
    now: NOW,
  });

  assert.equal(result.status, "failed");
  assert.equal(codexCalled, false);
  assert.equal((await loadAggregate(harness.db, "task", "task-1")).state, "waiting_info");
  const diagnostic = comments.find((body) => String(body).includes("development-evidence.png"));
  assert.ok(diagnostic);
  assert.match(diagnostic, /comment image unavailable: development-evidence\.png \(INVALID_IMAGE\)/);
  assert.doesNotMatch(diagnostic, /attachment-secret|taskboard-clickup-images-|\/tmp\//);
});

test("development waits for info when ClickUp comments cannot be fetched", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const comments = [];
  let codexCalled = false;
  const result = await executeDevelopment({
    job: JOB,
    db: harness.db,
    client: makeClient({
      getComments: async () => {
        throw new Error("https://api.clickup.com?token=secret Authorization: Bearer secret /tmp/private");
      },
      postComment: async (_taskId, body) => comments.push(body),
    }),
    codex: { run: async () => { codexCalled = true; return { exitCode: 0, stdout: validOutput(), stderr: "" }; } },
    gitOps: mockGitOps(),
    now: NOW,
  });

  assert.equal(result.classification, "needs_info");
  assert.equal(codexCalled, false);
  assert.equal((await loadAggregate(harness.db, "task", "task-1")).state, "waiting_info");
  assert.match(comments.at(-1), /comment history unavailable \(COMMENTS_UNAVAILABLE\)/);
  assert.doesNotMatch(comments.at(-1), /secret|api\.clickup\.com|\/tmp\//);
});

test("development routes a Codex image decoder failure to waiting info", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const comments = [];
  const result = await executeDevelopment({
    job: JOB,
    db: harness.db,
    client: makeClient({
      getComments: async () => [{
        id: "decoder-development",
        images: [{ filename: "decoder-development.png", url: "https://attachments.clickup.com/decoder-development.png" }],
      }],
      downloadAttachment: async () => ({ body: PNG, contentType: "image/png" }),
      postComment: async (_taskId, body) => comments.push(body),
    }),
    codex: {
      run: async ({ imagePaths }) => ({
        exitCode: 1,
        stdout: "",
        stderr: `invalid image decoder input ${imagePaths[0]}?token=decoder-secret`,
      }),
    },
    gitOps: mockGitOps(),
    now: NOW,
  });

  assert.equal(result.classification, "needs_info");
  assert.equal((await loadAggregate(harness.db, "task", "task-1")).state, "waiting_info");
  assert.match(comments.at(-1), /comment image unavailable: decoder-development\.png \(IMAGE_DECODE_FAILED\)/);
  assert.doesNotMatch(comments.at(-1), /decoder-secret|taskboard-clickup-images-|\/tmp\//);
});

test("development posts one safe ClickUp diagnostic when older comment images are truncated", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const posts = [];
  const mediaComments = Array.from({ length: 9 }, (_, index) => ({
    id: `development-limit-${index}`,
    date: String(9 - index),
    images: [{
      filename: index === 8 ? "oldest.png?token=truncate-secret" : `image-${index}.png`,
      url: `https://attachments.clickup.com/image-${index}.png?signature=private-${index}`,
    }],
  }));
  const result = await executeDevelopment({
    job: JOB,
    db: harness.db,
    client: makeClient({
      getComments: async () => mediaComments,
      downloadAttachment: async () => ({ body: PNG, contentType: "image/png" }),
      postComment: async (_taskId, body) => posts.push(body),
    }),
    codex: { run: async () => ({ exitCode: 0, stdout: validOutput(), stderr: "" }) },
    gitOps: mockGitOps(),
    now: NOW,
  });

  assert.equal(result.status, "completed");
  const diagnostics = posts.filter((body) => body.includes("部分评论图片未读取"));
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /评论 development-limit-8 图片：oldest\.png（IMAGE_LIMIT）/);
  assert.doesNotMatch(diagnostics[0], /truncate-secret|signature=|attachments\.clickup\.com|taskboard-clickup-images-|\/tmp\//);
});

test("development keeps the newest ClickUp feedback when comments are newest-first", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  let prompt = "";
  const comments = Array.from({ length: 15 }, (_, index) => ({
    id: `c-${index}`,
    date: String(1_000_000 - index),
    comment_text: index === 0
      ? "最新人工验收：测试环境仍然不是95折"
      : `历史评论 ${index}`,
  }));

  const result = await executeDevelopment({
    job: JOB,
    db: harness.db,
    client: makeClient({ getComments: async () => comments }),
    codex: {
      run: async ({ prompt: value }) => {
        prompt = value;
        return { exitCode: 0, stdout: validOutput(), stderr: "" };
      },
    },
    gitOps: mockGitOps(),
    now: NOW,
  });

  assert.equal(result.status, "completed");
  assert.match(prompt, /最新人工验收：测试环境仍然不是95折/);
  assert.doesNotMatch(prompt, /历史评论 14/);
});

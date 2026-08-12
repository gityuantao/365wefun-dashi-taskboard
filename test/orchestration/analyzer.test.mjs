import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { VALID_PNG } from "../helpers/image-fixtures.mjs";
import { executeAnalysis } from "../../orchestration/ai/analyzer.mjs";

const NOW = "2026-08-04T00:01:00.000Z";
const PNG = VALID_PNG;
const CORRUPT_IMAGE = Uint8Array.from([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]);

function validOutput() {
  return JSON.stringify({
    summary: "修复录音回放按钮不可点击的问题",
    scope: "实现录音回放按钮",
    acceptance_criteria: [
      { id: "ac-1", criterion: "按钮可点击", verification: "手动测试" },
    ],
    test_notes: ["提交录音后点击回放按钮，应能正常播放"],
    risks: [],
    open_questions: [],
  });
}

async function setupTask(harness) {
  const result = await dispatchCommand({
    db: harness.db,
    command: parseCommandEnvelope({
      id: "seed-analysis",
      type: "start_analysis",
      aggregateType: "task",
      aggregateId: "task-1",
      expectedVersion: 1,
      actorId: "system-poller",
      issuedAt: NOW,
      reason: "start",
      parameters: {},
    }),
    now: NOW,
  });
  assert.equal(result.status, "succeeded");
}

function makeClient(overrides = {}) {
  return {
    getTask: async () => ({
      id: "task-1",
      name: "录音回放按钮",
      description: "修复录音回放",
      status: { status: "分析中" },
      custom_fields: [
        { id: "field-version", name: "目标版本", value: "version-9" },
      ],
    }),
    postComment: async () => ({}),
    updateTaskDescription: async () => ({}),
    updateCustomField: async () => ({}),
    getComments: async () => [],
    ...overrides,
  };
}

test("analysis passes the 影响平台 field into the prompt", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  let prompt = "";
  const result = await executeAnalysis({
    job: { id: "job-a10", commandId: "cmd-a10", jobType: "analyze", payload: { taskId: "task-1" } },
    db: harness.db,
    client: makeClient({
      getTask: async () => ({
        id: "task-1",
        name: "录音回放按钮",
        description: "修复录音回放",
        status: { status: "分析中" },
        custom_fields: [
          { id: "field-version", name: "目标版本", value: "version-9" },
          { id: "field-platforms", name: "影响平台", value: ["web", "ios"] },
        ],
      }),
    }),
    codex: { run: async ({ prompt: p }) => { prompt = p; return { exitCode: 0, stdout: validOutput(), stderr: "" }; } },
    now: NOW,
  });
  assert.equal(result.status, "completed");
  assert.match(prompt, /影响平台（ClickUp 字段）：web、ios/);
  assert.deepEqual(result.platforms, ["web", "ios"]);
});

test("analysis persists an inferred iOS platform when the ClickUp platform field is empty", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const result = await executeAnalysis({
    job: { id: "job-a-ios", commandId: "cmd-a-ios", jobType: "analyze", payload: { taskId: "task-1" } },
    db: harness.db,
    client: makeClient({
      getTask: async () => ({
        id: "task-1",
        name: "IOS 话题视频页面不展示下一页按钮",
        description: "iOS 客户端话题视频分页",
        status: { status: "分析中" },
        custom_fields: [
          { id: "field-version", name: "目标版本", value: "version-9" },
          { id: "field-platforms", name: "影响平台", value: [] },
        ],
      }),
    }),
    codex: { run: async () => ({ exitCode: 0, stdout: validOutput(), stderr: "" }) },
    now: NOW,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.platforms, ["ios"]);
});

test("analysis blocks when the task has no target version", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const result = await executeAnalysis({
    job: { id: "job-a5", commandId: "cmd-a5", jobType: "analyze", payload: { taskId: "task-1" } },
    db: harness.db,
    client: makeClient({
      getTask: async () => ({
        id: "task-1",
        name: "录音回放按钮",
        description: "修复录音回放",
        status: { status: "分析中" },
        custom_fields: [],
      }),
    }),
    codex: { run: async () => ({ exitCode: 0, stdout: validOutput(), stderr: "" }) },
    now: NOW,
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /target version/i);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "waiting_info");
});

test("analysis completes and advances the task to ready for development", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const client = makeClient();
  const result = await executeAnalysis({
    job: { id: "job-a1", commandId: "cmd-a1", jobType: "analyze", payload: { taskId: "task-1" } },
    db: harness.db,
    client,
    codex: { run: async ({ prompt }) => ({ exitCode: 0, stdout: validOutput(), stderr: "" }) },
    now: NOW,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.summary.scope, "实现录音回放按钮");
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_development");
  assert.equal(aggregate.version, 2);
});

test("analysis with open questions blocks without advancing", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const output = JSON.stringify({
    scope: "实现录音回放按钮",
    acceptance_criteria: [{ id: "ac-1", criterion: "按钮可点击", verification: "手动测试" }],
    risks: [],
    open_questions: [{ question: "是否支持旧版本？" }],
  });
  const result = await executeAnalysis({
    job: { id: "job-a2", commandId: "cmd-a2", jobType: "analyze", payload: { taskId: "task-1" } },
    db: harness.db,
    client: makeClient(),
    codex: { run: async () => ({ exitCode: 0, stdout: output, stderr: "" }) },
    now: NOW,
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /needs_human/);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "waiting_info");
  assert.equal(aggregate.version, 2);
});

test("analysis does not publish its question comment when a manual pause wins the transition", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  let aggregateReads = 0;
  const racingDb = {
    prepare(sql) {
      const statement = harness.db.prepare(sql);
      if (!String(sql).includes("FROM orchestration_aggregates")) return statement;
      aggregateReads += 1;
      if (aggregateReads !== 4) return statement;
      return {
        bind(...args) {
          const bound = statement.bind(...args);
          return {
            async first() {
              await dispatchCommand({
                db: harness.db,
                command: parseCommandEnvelope({
                  id: "manual-pause-before-analysis-question",
                  type: "analysis_needs_human",
                  aggregateType: "task",
                  aggregateId: "task-1",
                  expectedVersion: 2,
                  actorId: "system-poller",
                  issuedAt: NOW,
                  reason: "user moved task to waiting_info",
                  parameters: {},
                }),
                now: NOW,
              });
              return bound.first();
            },
          };
        },
      };
    },
  };
  const comments = [];
  const output = JSON.stringify({
    scope: "实现录音回放按钮",
    acceptance_criteria: [{ id: "ac-1", criterion: "按钮可点击", verification: "手动测试" }],
    risks: [],
    open_questions: [{ question: "是否支持旧版本？" }],
  });

  const result = await executeAnalysis({
    job: { id: "job-question-race", commandId: "cmd-question-race", jobType: "analyze", payload: { taskId: "task-1", aggregateVersion: 1 } },
    db: racingDb,
    client: makeClient({ postComment: async (_id, body) => comments.push(body) }),
    codex: { run: async () => ({ exitCode: 0, stdout: output, stderr: "" }) },
    now: NOW,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.classification, "paused_waiting_info");
  assert.deepEqual(comments, []);
});

test("manual pause during Codex analysis prevents ClickUp writes and completion", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const sideEffects = [];
  const result = await executeAnalysis({
    job: {
      id: "job-analysis-paused",
      commandId: "auto-analyze-task-1",
      jobType: "analyze",
      payload: { taskId: "task-1", aggregateVersion: 1 },
    },
    db: harness.db,
    client: makeClient({
      postComment: async () => sideEffects.push("comment"),
      updateTaskDescription: async () => sideEffects.push("description"),
      updateCustomField: async () => sideEffects.push("field"),
    }),
    codex: {
      run: async () => {
        await dispatchCommand({
          db: harness.db,
          command: parseCommandEnvelope({
            id: "manual-pause-during-analysis",
            type: "analysis_needs_human",
            aggregateType: "task",
            aggregateId: "task-1",
            expectedVersion: 2,
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
    now: NOW,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.classification, "paused_waiting_info");
  assert.deepEqual(sideEffects, []);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "waiting_info");
  const completion = await harness.db
    .prepare("SELECT id FROM orchestration_events WHERE type = 'task.analysis_completed'")
    .first();
  assert.equal(completion, null);
});

test("analysis rejects invalid structured output", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  for (const stdout of ["not json", JSON.stringify({ scope: "x" })]) {
    const result = await executeAnalysis({
      job: { id: "job-a3", commandId: "cmd-a3", jobType: "analyze", payload: { taskId: "task-1" } },
      db: harness.db,
      client: makeClient(),
      codex: { run: async () => ({ exitCode: 0, stdout, stderr: "" }) },
      now: NOW,
    });
    assert.equal(result.status, "failed");
  }
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "analyzing");
});

test("analysis writes the description, execution summary and a comment", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const calls = [];
  const client = makeClient({
    postComment: async (id, body) => calls.push(["comment", id, body]),
    updateTaskDescription: async (id, description) => calls.push(["description", id, description]),
    updateCustomField: async (id, field, value) => calls.push(["field", id, field, value]),
  });
  await executeAnalysis({
    job: { id: "job-a4", commandId: "cmd-a4", jobType: "analyze", payload: { taskId: "task-1" } },
    db: harness.db,
    client,
    codex: { run: async () => ({ exitCode: 0, stdout: validOutput(), stderr: "" }) },
    now: NOW,
  });
  assert.ok(calls.some(([kind]) => kind === "comment"));
  assert.ok(calls.some(([kind, , field]) => kind === "field" && field === "field-summary"));
  const descriptionCall = calls.find(([kind]) => kind === "description");
  assert.ok(descriptionCall);
  assert.match(descriptionCall[2], /## 问题/);
  assert.match(descriptionCall[2], /修复录音回放按钮不可点击的问题/);
  assert.match(descriptionCall[2], /## 测试要点/);
  assert.match(descriptionCall[2], /提交录音后点击回放按钮，应能正常播放/);
});

test("analysis sends comment images to Codex with their comment label and cleans them up", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  let options;
  let downloadedPath;
  const result = await executeAnalysis({
    job: { id: "job-a9", commandId: "cmd-a9", jobType: "analyze", payload: { taskId: "task-1" } },
    db: harness.db,
    client: makeClient({
      getComments: async () => [
        {
          id: "c1",
          comment_text: "需求补充：移动端也要支持",
          attachments: [{ title: "mobile-layout.png", url: "https://attachments.clickup.com/mobile-layout.png" }],
        },
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
    now: NOW,
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(options.imagePaths, [downloadedPath]);
  assert.match(options.prompt, /需求补充：移动端也要支持/);
  assert.match(options.prompt, /评论 c1 图片：mobile-layout\.png/);
  await assert.rejects(access(downloadedPath));
});

test("analysis waits for info when a selected comment image is corrupt", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const comments = [];
  let codexCalled = false;
  const result = await executeAnalysis({
    job: { id: "job-a-image-failed", commandId: "cmd-a-image-failed", jobType: "analyze", payload: { taskId: "task-1" } },
    db: harness.db,
    client: makeClient({
      getComments: async () => [{
        id: "comment-corrupt-analysis",
        attachments: [{
          title: "analysis-evidence.png?token=attachment-secret",
          url: "https://attachments.clickup.com/analysis-evidence.png?token=attachment-secret",
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
    now: NOW,
  });

  assert.equal(result.status, "failed");
  assert.equal(codexCalled, false);
  assert.equal((await loadAggregate(harness.db, "task", "task-1")).state, "waiting_info");
  const diagnostic = comments.find((body) => String(body).includes("analysis-evidence.png"));
  assert.ok(diagnostic);
  assert.match(diagnostic, /comment image unavailable: analysis-evidence\.png \(INVALID_IMAGE\)/);
  assert.doesNotMatch(diagnostic, /attachment-secret|taskboard-clickup-images-|\/tmp\//);
});

test("analysis waits for info when ClickUp comments cannot be fetched", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const comments = [];
  let codexCalled = false;
  const result = await executeAnalysis({
    job: { id: "job-comments-analysis", payload: { taskId: "task-1" } },
    db: harness.db,
    client: makeClient({
      getComments: async () => {
        throw new Error("https://api.clickup.com?token=secret Authorization: Bearer secret /tmp/private");
      },
      postComment: async (_taskId, body) => comments.push(body),
    }),
    codex: { run: async () => { codexCalled = true; return { exitCode: 0, stdout: validOutput(), stderr: "" }; } },
    now: NOW,
  });

  assert.equal(result.classification, "needs_human");
  assert.equal(codexCalled, false);
  assert.equal((await loadAggregate(harness.db, "task", "task-1")).state, "waiting_info");
  assert.match(comments[0], /comment history unavailable \(COMMENTS_UNAVAILABLE\)/);
  assert.doesNotMatch(comments[0], /secret|api\.clickup\.com|\/tmp\//);
});

test("analysis routes a Codex image decoder failure to waiting info", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const comments = [];
  const result = await executeAnalysis({
    job: { id: "job-decoder-analysis", payload: { taskId: "task-1" } },
    db: harness.db,
    client: makeClient({
      getComments: async () => [{
        id: "decoder-analysis",
        images: [{ filename: "decoder-analysis.png", url: "https://attachments.clickup.com/decoder-analysis.png" }],
      }],
      downloadAttachment: async () => ({ body: PNG, contentType: "image/png" }),
      postComment: async (_taskId, body) => comments.push(body),
    }),
    codex: {
      run: async ({ imagePaths }) => ({
        exitCode: 1,
        stdout: "",
        stderr: `failed to decode image ${imagePaths[0]}?token=decoder-secret`,
      }),
    },
    now: NOW,
  });

  assert.equal(result.classification, "needs_human");
  assert.equal((await loadAggregate(harness.db, "task", "task-1")).state, "waiting_info");
  assert.match(comments[0], /comment image unavailable: decoder-analysis\.png \(IMAGE_DECODE_FAILED\)/);
  assert.doesNotMatch(comments[0], /decoder-secret|taskboard-clickup-images-|\/tmp\//);
});

test("analysis posts one safe ClickUp diagnostic when older comment images are truncated", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const posts = [];
  const mediaComments = Array.from({ length: 9 }, (_, index) => ({
    id: `analysis-limit-${index}`,
    date: String(9 - index),
    images: [{
      filename: index === 8 ? "oldest.png?token=truncate-secret" : `image-${index}.png`,
      url: `https://attachments.clickup.com/image-${index}.png?signature=private-${index}`,
    }],
  }));
  const result = await executeAnalysis({
    job: { id: "job-limit-analysis", payload: { taskId: "task-1" } },
    db: harness.db,
    client: makeClient({
      getComments: async () => mediaComments,
      downloadAttachment: async () => ({ body: PNG, contentType: "image/png" }),
      postComment: async (_taskId, body) => posts.push(body),
    }),
    codex: { run: async () => ({ exitCode: 0, stdout: validOutput(), stderr: "" }) },
    now: NOW,
  });

  assert.equal(result.status, "completed");
  const diagnostics = posts.filter((body) => body.includes("部分评论图片未读取"));
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /评论 analysis-limit-8 图片：oldest\.png（IMAGE_LIMIT）/);
  assert.doesNotMatch(diagnostics[0], /truncate-secret|signature=|attachments\.clickup\.com|taskboard-clickup-images-|\/tmp\//);
});

test("analysis redacts a non-decoder Codex failure that includes a comment image path", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const result = await executeAnalysis({
    job: { id: "job-safe-failure-analysis", payload: { taskId: "task-1" } },
    db: harness.db,
    client: makeClient({
      getComments: async () => [{
        id: "safe-failure-analysis",
        images: [{ filename: "safe-failure.png", url: "https://attachments.clickup.com/safe-failure.png" }],
      }],
      downloadAttachment: async () => ({ body: PNG, contentType: "image/png" }),
    }),
    codex: {
      run: async ({ imagePaths }) => ({
        exitCode: 2,
        stdout: "",
        stderr: `model unavailable for ${imagePaths[0]}?token=runtime-secret`,
      }),
    },
    now: NOW,
  });

  assert.match(result.error, /CODEX_IMAGE_RUN_FAILED/);
  assert.doesNotMatch(result.error, /runtime-secret|taskboard-clickup-images-|\/tmp\//);
});

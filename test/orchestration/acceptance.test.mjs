import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { executeAcceptance } from "../../orchestration/ai/acceptance.mjs";
import { checkReworkBudget } from "../../orchestration/application/failure-handler.mjs";

const NOW = "2026-08-04T00:04:00.000Z";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CORRUPT_IMAGE = Uint8Array.from([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]);

async function seedToAccepting(harness) {
  for (let index = 0; index < 4; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed"][index];
    await dispatchCommand({
      db: harness.db,
      command: parseCommandEnvelope({
        id: `accept-seed-${index}`,
        type,
        aggregateType: "task",
        aggregateId: "task-1",
        expectedVersion: index + 1,
        actorId: "system",
        issuedAt: NOW,
        reason: "seed",
        parameters: {},
      }),
      now: NOW,
    });
  }
}

async function advanceToAcceptingAgain(harness, round) {
  let aggregate = await loadAggregate(harness.db, "task", "task-1");
  for (const type of ["start_development", "development_completed"]) {
    await dispatchCommand({
      db: harness.db,
      command: parseCommandEnvelope({
        id: `reaccept-${round}-${type}`,
        type,
        aggregateType: "task",
        aggregateId: "task-1",
        expectedVersion: aggregate.version + 1,
        actorId: "system",
        issuedAt: NOW,
        reason: "reseeding",
        parameters: {},
      }),
      now: NOW,
    });
    aggregate = await loadAggregate(harness.db, "task", "task-1");
  }
}

function makeClient(targetVersion, overrides = {}) {
  return {
    getTask: async () => ({
      id: "task-1",
      name: "录音回放按钮",
      description: "修复录音回放",
      custom_fields: [
        { id: "field-version", name: "目标版本", value: targetVersion },
      ],
    }),
    postComment: async () => ({}),
    updateCustomField: async () => ({}),
    getComments: async () => [],
    ...overrides,
  };
}

const JOB = {
  id: "job-ac1",
  commandId: "cmd-ac1",
  jobType: "accept",
  payload: {
    taskId: "task-1",
    acceptanceCriteria: [
      { id: "ac-1", criterion: "按钮可点击", verification: "手动测试" },
    ],
    commitSha: "abc123",
    aggregateVersion: 4,
  },
};

function acceptedOutput() {
  return JSON.stringify({
    acceptance_result: "accepted",
    criteria_results: [{ id: "ac-1", result: "passed" }],
    findings: [],
  });
}

function rejectedOutput() {
  return JSON.stringify({
    acceptance_result: "rejected",
    criteria_results: [{ id: "ac-1", result: "failed" }],
    findings: [{ severity: "high", description: "按钮无法点击" }],
  });
}

test("acceptance passes and waits for staging with a target version", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToAccepting(harness);
  const posts = [];
  const result = await executeAcceptance({
    job: JOB,
    db: harness.db,
    client: makeClient("version-9", {
      postComment: async (id, body) => posts.push(body),
    }),
    codex: { run: async () => ({ exitCode: 0, stdout: acceptedOutput(), stderr: "" }) },
    now: NOW,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.result, "accepted");
  assert.deepEqual(result.findings, []);
  assert.ok(posts.some((body) => body.includes("代码自动验收通过，正在合并并部署测试环境")));
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "accepting");
});

test("acceptance refuses to advance without a target version", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToAccepting(harness);
  const result = await executeAcceptance({
    job: JOB,
    db: harness.db,
    client: makeClient(null),
    codex: { run: async () => ({ exitCode: 0, stdout: acceptedOutput(), stderr: "" }) },
    now: NOW,
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /target version/i);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "accepting");
});

test("manual pause during Codex acceptance prevents writes and completion", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToAccepting(harness);
  const sideEffects = [];
  const result = await executeAcceptance({
    job: JOB,
    db: harness.db,
    client: makeClient("version-9", {
      postComment: async () => sideEffects.push("comment"),
      updateCustomField: async () => sideEffects.push("field"),
    }),
    codex: {
      run: async () => {
        await dispatchCommand({
          db: harness.db,
          command: parseCommandEnvelope({
            id: "manual-pause-during-acceptance",
            type: "manual_pause_for_info",
            aggregateType: "task",
            aggregateId: "task-1",
            expectedVersion: 5,
            actorId: "system-poller",
            issuedAt: NOW,
            reason: "user moved task to waiting_info",
            parameters: {},
          }),
          now: NOW,
        });
        return { exitCode: 0, stdout: acceptedOutput(), stderr: "" };
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
    .prepare("SELECT id FROM orchestration_events WHERE type IN ('task.acceptance_passed', 'task.acceptance_failed')")
    .first();
  assert.equal(completion, null);
});

test("remote waiting_info immediately before acceptance result prevents acceptance_passed", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToAccepting(harness);
  const comments = [];
  let reads = 0;
  const client = makeClient("version-9", {
    getTask: async () => {
      reads += 1;
      if (reads === 1) {
        return {
          id: "task-1",
          name: "录音回放按钮",
          description: "修复录音回放",
          status: { status: "开发中" },
          custom_fields: [
            { id: "field-version", name: "目标版本", value: "version-9" },
          ],
        };
      }
      return {
        id: "task-1",
        status: { status: "待补充信息" },
        custom_fields: [],
      };
    },
    postComment: async (_id, body) => comments.push(body),
  });

  const result = await executeAcceptance({
    job: JOB,
    db: harness.db,
    client,
    codex: { run: async () => ({ exitCode: 0, stdout: acceptedOutput(), stderr: "" }) },
    now: NOW,
  });

  assert.equal(reads, 2, "acceptance must confirm the remote status immediately before result dispatch");
  assert.equal(result.status, "failed");
  assert.equal(result.classification, "paused_waiting_info");
  assert.equal(comments.some((body) => body.includes("自动验收通过")), false);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "waiting_info");
  const passed = await harness.db
    .prepare("SELECT id FROM orchestration_events WHERE type = 'task.acceptance_passed'")
    .first();
  assert.equal(passed, null);
});

test("acceptance rejection returns the task to ready for development", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToAccepting(harness);
  const result = await executeAcceptance({
    job: JOB,
    db: harness.db,
    client: makeClient("version-9"),
    codex: { run: async () => ({ exitCode: 0, stdout: rejectedOutput(), stderr: "" }) },
    now: NOW,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.result, "rejected");
  assert.deepEqual(result.findings, [{ severity: "high", description: "按钮无法点击" }]);
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_development");
});

test("acceptance rejection keeps the comment concise and the field complete", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToAccepting(harness);
  const posts = [];
  const fields = [];
  const long = `这是一段非常长的验收失败原因说明，${"重复内容".repeat(80)}`;
  const output = JSON.stringify({
    acceptance_result: "rejected",
    criteria_results: [{ id: "ac-1", result: "failed" }],
    findings: [{ severity: "high", description: long }],
  });
  const result = await executeAcceptance({
    job: JOB,
    db: harness.db,
    client: makeClient("version-9", {
      postComment: async (id, body) => posts.push(body),
      updateCustomField: async (id, field, value) => fields.push([field, value]),
    }),
    codex: { run: async () => ({ exitCode: 0, stdout: output, stderr: "" }) },
    now: NOW,
    fieldIds: { feedback: "field-feedback" },
  });
  assert.equal(result.status, "completed");
  const comment = posts.find((body) => body.includes("验收不通过"));
  const field = fields.find(([name]) => name === "field-feedback");
  assert.ok(comment);
  assert.ok(field);
  assert.ok(comment.includes("…"));
  assert.ok(comment.length < long.length);
  assert.ok(field[1].includes(long));
});

test("acceptance failure auto-redevelops and parks after repeated failures", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToAccepting(harness);
  for (let round = 1; round <= 3; round += 1) {
    const beforeAcceptance = await loadAggregate(harness.db, "task", "task-1");
    const result = await executeAcceptance({
      job: {
        ...JOB,
        id: `job-r${round}`,
        payload: { ...JOB.payload, aggregateVersion: beforeAcceptance.version },
      },
      db: harness.db,
      client: makeClient("version-9"),
      codex: { run: async () => ({ exitCode: 0, stdout: rejectedOutput(), stderr: "" }) },
      now: NOW,
    });
    assert.equal(result.status, "completed");
    const aggregate = await loadAggregate(harness.db, "task", "task-1");
    if (round < 3) {
      assert.equal(aggregate.state, "ready_for_development");
      await advanceToAcceptingAgain(harness, round);
    } else {
      assert.equal(aggregate.state, "acceptance_rejected");
    }
  }
  const budget = await checkReworkBudget({ db: harness.db, taskId: "task-1" });
  assert.equal(budget.round, 3);
  assert.equal(budget.exhausted, true);
});

test("acceptance rejects invalid structured output", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToAccepting(harness);
  const result = await executeAcceptance({
    job: JOB,
    db: harness.db,
    client: makeClient("version-9"),
    codex: { run: async () => ({ exitCode: 0, stdout: "garbage", stderr: "" }) },
    now: NOW,
  });
  assert.equal(result.status, "failed");
});

test("acceptance sends comment images to Codex with their comment label and cleans them up", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToAccepting(harness);
  let options;
  let downloadedPath;
  const result = await executeAcceptance({
    job: JOB,
    db: harness.db,
    client: makeClient("version-9", {
      getComments: async () => [
        {
          id: "c1",
          comment_text: "❌ 验收不通过：按钮无法点击，已退回待开发。",
          attachments: [{ title: "acceptance-failure.png", url: "https://attachments.clickup.com/acceptance-failure.png" }],
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
        return { exitCode: 0, stdout: acceptedOutput(), stderr: "" };
      },
    },
    now: NOW,
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(options.imagePaths, [downloadedPath]);
  assert.match(options.prompt, /验收不通过：按钮无法点击/);
  assert.match(options.prompt, /评论 c1 图片：acceptance-failure\.png/);
  await assert.rejects(access(downloadedPath));
});

test("acceptance waits for info when a selected comment image is corrupt", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToAccepting(harness);
  const comments = [];
  let codexCalled = false;
  const result = await executeAcceptance({
    job: JOB,
    db: harness.db,
    client: makeClient("version-9", {
      getComments: async () => [{
        id: "comment-corrupt-acceptance",
        attachments: [{
          title: "acceptance-evidence.png",
          url: "https://attachments.clickup.com/acceptance-evidence.png?token=attachment-secret",
        }],
      }],
      downloadAttachment: async () => ({
        body: CORRUPT_IMAGE,
        contentType: "image/png",
        contentLength: CORRUPT_IMAGE.byteLength,
      }),
      postComment: async (_taskId, body) => comments.push(body),
    }),
    codex: { run: async () => { codexCalled = true; return { exitCode: 0, stdout: acceptedOutput(), stderr: "" }; } },
    now: NOW,
  });

  assert.equal(result.status, "failed");
  assert.equal(codexCalled, false);
  assert.equal((await loadAggregate(harness.db, "task", "task-1")).state, "waiting_info");
  const diagnostic = comments.find((body) => String(body).includes("acceptance-evidence.png"));
  assert.ok(diagnostic);
  assert.match(diagnostic, /comment image unavailable: acceptance-evidence\.png \(INVALID_IMAGE\)/);
  assert.doesNotMatch(diagnostic, /attachment-secret|taskboard-clickup-images-|\/tmp\//);
});

test("acceptance rejection posts full findings and writes the feedback field", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToAccepting(harness);
  const posts = [];
  const fields = [];
  const rejectedMany = JSON.stringify({
    acceptance_result: "rejected",
    criteria_results: [
      { id: "ac-1", result: "failed" },
      { id: "ac-2", result: "failed" },
    ],
    findings: [
      { severity: "high", description: "小程序邮箱错误文案不统一" },
      { severity: "high", description: "昵称长度上限应为 20" },
    ],
  });
  const result = await executeAcceptance({
    job: JOB,
    db: harness.db,
    client: makeClient("version-9", {
      postComment: async (id, body) => posts.push(body),
      updateCustomField: async (id, field, value) => fields.push([field, value]),
    }),
    codex: { run: async () => ({ exitCode: 0, stdout: rejectedMany, stderr: "" }) },
    now: NOW,
    fieldIds: { feedback: "field-feedback" },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.result, "rejected");
  assert.ok(posts.some((body) => body.includes("昵称长度上限应为 20")));
  assert.ok(
    fields.some(([field, value]) => field === "field-feedback" && value.includes("小程序邮箱错误文案不统一")),
  );
});

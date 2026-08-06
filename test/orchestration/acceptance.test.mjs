import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { executeAcceptance } from "../../orchestration/ai/acceptance.mjs";

const NOW = "2026-08-04T00:04:00.000Z";

async function seedToAccepting(harness) {
  for (let index = 0; index < 7; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "start_test", "test_passed", "start_acceptance"][index];
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

test("acceptance passes and advances to ready for release with a target version", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToAccepting(harness);
  const result = await executeAcceptance({
    job: JOB,
    db: harness.db,
    client: makeClient("version-9"),
    codex: { run: async () => ({ exitCode: 0, stdout: acceptedOutput(), stderr: "" }) },
    now: NOW,
  });
  assert.equal(result.status, "completed");
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_release");
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
  const aggregate = await loadAggregate(harness.db, "task", "task-1");
  assert.equal(aggregate.state, "ready_for_development");
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

test("acceptance reads comments and includes previous feedback in the prompt", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedToAccepting(harness);
  let prompt = "";
  const result = await executeAcceptance({
    job: JOB,
    db: harness.db,
    client: makeClient("version-9", {
      getComments: async () => [
        { id: "c1", comment_text: "❌ 验收不通过：按钮无法点击，已退回待开发。" },
      ],
    }),
    codex: { run: async ({ prompt: p }) => { prompt = p; return { exitCode: 0, stdout: acceptedOutput(), stderr: "" }; } },
    now: NOW,
  });
  assert.equal(result.status, "completed");
  assert.match(prompt, /验收不通过：按钮无法点击/);
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

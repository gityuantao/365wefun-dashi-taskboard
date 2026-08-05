import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { executeAnalysis } from "../../orchestration/ai/analyzer.mjs";

const NOW = "2026-08-04T00:01:00.000Z";

function validOutput() {
  return JSON.stringify({
    scope: "实现录音回放按钮",
    acceptance_criteria: [
      { id: "ac-1", criterion: "按钮可点击", verification: "手动测试" },
    ],
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
    }),
    postComment: async () => ({}),
    updateCustomField: async () => ({}),
    ...overrides,
  };
}

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
  assert.equal(aggregate.state, "analyzing");
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

test("analysis writes the execution summary and a comment", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await setupTask(harness);
  const calls = [];
  const client = makeClient({
    postComment: async (id, body) => calls.push(["comment", id, body]),
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
});

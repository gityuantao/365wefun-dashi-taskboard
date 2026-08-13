import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createOrchestratorLifecycle,
  guardDurableMethods,
  runCodex,
} from "../../orchestration/runner/codex-runner.mjs";

function mockChild(events) {
  const child = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {} };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    events.push(`child.kill:${signal}`);
    return true;
  };
  return child;
}

test("SIGTERM stops claims, cancels active runs, drains settlement, and closes resources", async () => {
  const signals = new EventEmitter();
  const events = [];
  let settleJob;
  const jobSettled = new Promise((resolve) => { settleJob = resolve; });
  const lifecycle = createOrchestratorLifecycle({
    dashboardServer: { close: async () => { events.push("dashboard.close"); } },
    miniflare: { dispose: async () => { events.push("miniflare.dispose"); } },
    clearIntervalImpl: (handle) => events.push(`interval.clear:${handle}`),
  });
  lifecycle.setPollingInterval("poll-1");
  lifecycle.installSignalHandlers(signals);
  const running = lifecycle.runJob({ id: "job-1" }, async ({ signal }) => {
    await new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        events.push("codex.abort");
        resolve();
      }, { once: true });
    });
    await jobSettled;
    events.push("job.settled");
  });

  signals.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lifecycle.canClaim(), false);
  assert.deepEqual(events, ["interval.clear:poll-1", "codex.abort"]);

  settleJob();
  await running;
  await lifecycle.shutdown();
  assert.deepEqual(events, [
    "interval.clear:poll-1",
    "codex.abort",
    "job.settled",
    "dashboard.close",
    "miniflare.dispose",
  ]);
});

test("a claim finishing during shutdown is reconciled and never executed", async () => {
  let finishClaim;
  const claimed = new Promise((resolve) => { finishClaim = resolve; });
  const events = [];
  const lifecycle = createOrchestratorLifecycle();
  const claimAttempt = lifecycle.claimAndRun({
    claim: () => claimed,
    reconcile: async (job) => events.push(`reconciled:${job.id}`),
    execute: async (job) => events.push(`executed:${job.id}`),
  });

  const shutdown = lifecycle.shutdown();
  finishClaim({ id: "job-race" });
  await Promise.all([claimAttempt, shutdown]);

  assert.deepEqual(events, ["reconciled:job-race"]);
});

test("lifecycle permits only one active runner job", async () => {
  const lifecycle = createOrchestratorLifecycle();
  let finish;
  const blocked = new Promise((resolve) => { finish = resolve; });

  const first = await lifecycle.claimAndRun({
    claim: async () => ({ id: "job-1" }),
    execute: async () => blocked,
  });

  assert.equal(first.id, "job-1");
  assert.equal(lifecycle.canClaim(), false);
  const second = await lifecycle.claimAndRun({
    claim: async () => ({ id: "job-2" }),
    execute: async () => {},
  });
  assert.equal(second, null);

  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lifecycle.canClaim(), true);
  await lifecycle.shutdown();
});

test("lifecycle closes resources only after a SIGTERM-delayed Codex child closes", async () => {
  const events = [];
  const child = mockChild(events);
  const lifecycle = createOrchestratorLifecycle({
    dashboardServer: { close: async () => events.push("dashboard.close") },
    miniflare: { dispose: async () => events.push("miniflare.dispose") },
  });
  const running = lifecycle.runJob({ id: "job-codex" }, ({ signal }) => runCodex({
    workdir: "/tmp",
    prompt: "long running task",
    signal,
    abortGraceMs: 1_000,
    spawnImpl: () => child,
  }));

  const shutdown = lifecycle.shutdown();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["child.kill:SIGTERM"]);

  events.push("child.close");
  child.emit("close", null);
  await Promise.all([running, shutdown]);
  assert.deepEqual(events, [
    "child.kill:SIGTERM",
    "child.close",
    "dashboard.close",
    "miniflare.dispose",
  ]);
});

test("lifecycle waits for explicit non-cooperative child termination failure before closing", async () => {
  const events = [];
  const child = mockChild(events);
  const lifecycle = createOrchestratorLifecycle({
    dashboardServer: { close: async () => events.push("dashboard.close") },
    miniflare: { dispose: async () => events.push("miniflare.dispose") },
  });
  const running = lifecycle.runJob({ id: "job-stuck" }, ({ signal }) => runCodex({
    workdir: "/tmp",
    prompt: "ignores every signal",
    signal,
    abortGraceMs: 5,
    abortForceCloseMs: 5,
    spawnImpl: () => child,
  }));
  const observed = assert.rejects(running, /TERMINATION_TIMEOUT/);

  await lifecycle.shutdown();
  await observed;
  assert.deepEqual(events, [
    "child.kill:SIGTERM",
    "child.kill:SIGKILL",
    "dashboard.close",
    "miniflare.dispose",
  ]);
});

test("lifecycle does not close resources before a runtime-timed-out Codex child closes", async () => {
  const events = [];
  const child = mockChild(events);
  const lifecycle = createOrchestratorLifecycle({
    dashboardServer: { close: async () => events.push("dashboard.close") },
    miniflare: { dispose: async () => events.push("miniflare.dispose") },
  });
  const running = lifecycle.runJob({ id: "job-runtime-timeout" }, ({ signal }) => runCodex({
    workdir: "/tmp",
    prompt: "runtime timeout",
    timeoutMinutes: 0.0001,
    signal,
    abortGraceMs: 100,
    spawnImpl: () => child,
  }));

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(events, ["child.kill:SIGTERM"]);
  const shutdown = lifecycle.shutdown();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["child.kill:SIGTERM"]);

  events.push("child.close");
  child.emit("close", null);
  const [result] = await Promise.all([running, shutdown]);
  assert.equal(result.timedOut, true);
  assert.deepEqual(events, [
    "child.kill:SIGTERM",
    "child.close",
    "dashboard.close",
    "miniflare.dispose",
  ]);
});

test("durable method guards validate the claim immediately before every boundary", async () => {
  const events = [];
  let active = true;
  const guarded = guardDurableMethods({
    postComment: async () => events.push("comment.write"),
    getTask: async () => events.push("task.read"),
  }, {
    methods: ["postComment"],
    assertActive: async () => {
      events.push("claim.check");
      if (!active) throw new Error("CLAIM_MISMATCH");
    },
  });

  await guarded.getTask();
  await guarded.postComment();
  active = false;
  await assert.rejects(guarded.postComment(), /CLAIM_MISMATCH/);

  assert.deepEqual(events, [
    "task.read",
    "claim.check",
    "comment.write",
    "claim.check",
  ]);
});

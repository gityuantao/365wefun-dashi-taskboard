import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { runCodex } from "../../orchestration/runner/codex-runner.mjs";

function mockChild() {
  const child = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {} };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

test("runCodex rejects empty prompts", () => {
  assert.throws(
    () => runCodex({ workdir: "/tmp", prompt: "  " }),
    /INVALID_PROMPT/,
  );
});

test("runCodex streams output and resolves the exit code", async () => {
  const child = mockChild();
  const calls = [];
  const spawnImpl = (bin, args, options) => {
    calls.push({ bin, args, options });
    return child;
  };
  const promise = runCodex({
    workdir: "/tmp",
    prompt: "analyze this",
    skillPath: "/skills/manage-taskboard",
    spawnImpl,
  });
  child.stdout.emit("data", Buffer.from("working..."));
  child.emit("close", 0);
  const result = await promise;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "working...");
  assert.equal(calls[0].bin, "codex");
  assert.deepEqual(calls[0].args, ["exec", "--skill", "/skills/manage-taskboard"]);
  assert.equal(calls[0].options.cwd, "/tmp");
});

test("runCodex attaches every comment image before an optional skill", async () => {
  const child = mockChild();
  let args;
  const promise = runCodex({
    workdir: "/tmp/worktree",
    prompt: "inspect screenshots",
    imagePaths: ["/tmp/a.png", "/tmp/b.jpg"],
    skillPath: "/skills/manage-taskboard",
    spawnImpl: (_bin, value) => {
      args = value;
      return child;
    },
  });
  child.emit("close", 0);
  await promise;

  assert.deepEqual(args, [
    "exec",
    "--image", "/tmp/a.png",
    "--image", "/tmp/b.jpg",
    "--skill", "/skills/manage-taskboard",
  ]);
});

test("runCodex rejects a relative comment image path before spawning", () => {
  let spawned = false;

  assert.throws(
    () => runCodex({
      workdir: "/tmp/worktree",
      prompt: "inspect screenshot",
      imagePaths: ["relative.png"],
      spawnImpl: () => {
        spawned = true;
        return mockChild();
      },
    }),
    (error) => error.code === "INVALID_IMAGE_PATH",
  );
  assert.equal(spawned, false);
});

test("runCodex preserves non-zero exits", async () => {
  const child = mockChild();
  const promise = runCodex({
    workdir: "/tmp",
    prompt: "do it",
    spawnImpl: () => child,
  });
  child.stderr.emit("data", Buffer.from("boom"));
  child.emit("close", 1);
  const result = await promise;
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /boom/);
});

test("runCodex rejects a non-abort child error immediately", async () => {
  const child = mockChild();
  const promise = runCodex({
    workdir: "/tmp",
    prompt: "fails normally",
    spawnImpl: () => child,
  });

  child.emit("error", new Error("pipe failed"));

  await assert.rejects(promise, /SPAWN_FAILED.*pipe failed/);
});

test("runCodex waits for child close before reporting a timed-out run", async () => {
  const child = mockChild();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  let settled = false;
  const promise = runCodex({
    workdir: "/tmp",
    prompt: "slow",
    timeoutMinutes: 0.001,
    abortGraceMs: 100,
    spawnImpl: () => child,
  }).finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(settled, false);
  child.emit("close", null);
  const result = await promise;
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
});

test("runCodex escalates a timed-out child and does not settle before termination failure", async () => {
  const child = mockChild();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const promise = runCodex({
    workdir: "/tmp",
    prompt: "stuck timeout",
    timeoutMinutes: 0.0001,
    abortGraceMs: 5,
    abortForceCloseMs: 5,
    spawnImpl: () => child,
  });

  await assert.rejects(promise, /TERMINATION_TIMEOUT/);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("runCodex waits for the child close after shutdown sends SIGTERM", async () => {
  const child = mockChild();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const controller = new AbortController();
  let settled = false;
  const promise = runCodex({
    workdir: "/tmp",
    prompt: "long running task",
    signal: controller.signal,
    spawnImpl: () => child,
  }).finally(() => { settled = true; });

  controller.abort(new Error("orchestrator shutdown"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(settled, false);
  child.emit("close", null);

  const result = await promise;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, null);
});

test("abort disables an imminent runtime timeout and does not settle before close", async () => {
  const child = mockChild();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const controller = new AbortController();
  let settled = false;
  const promise = runCodex({
    workdir: "/tmp",
    prompt: "timeout race",
    timeoutMinutes: 0.0001,
    signal: controller.signal,
    abortGraceMs: 100,
    spawnImpl: () => child,
  }).finally(() => { settled = true; });

  controller.abort(new Error("orchestrator shutdown"));
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(settled, false);
  child.emit("close", null);
  const result = await promise;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
});

test("an abort-time child error is recorded but does not settle before close", async () => {
  const child = mockChild();
  const controller = new AbortController();
  let settled = false;
  const promise = runCodex({
    workdir: "/tmp",
    prompt: "error race",
    signal: controller.signal,
    abortGraceMs: 100,
    spawnImpl: () => child,
  }).finally(() => { settled = true; });

  controller.abort(new Error("orchestrator shutdown"));
  child.emit("error", new Error("EPIPE during termination"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  child.emit("close", null);
  const result = await promise;
  assert.equal(result.aborted, true);
  assert.equal(result.terminationError, "EPIPE during termination");
});

test("runCodex escalates an uncooperative child to SIGKILL then fails explicitly", async () => {
  const child = mockChild();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const controller = new AbortController();
  const promise = runCodex({
    workdir: "/tmp",
    prompt: "ignores shutdown",
    signal: controller.signal,
    abortGraceMs: 5,
    abortForceCloseMs: 5,
    spawnImpl: () => child,
  });

  controller.abort(new Error("orchestrator shutdown"));
  child.emit("error", new Error("EPIPE while killing"));

  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "TERMINATION_TIMEOUT");
    assert.equal(error.details.childError, "EPIPE while killing");
    return true;
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

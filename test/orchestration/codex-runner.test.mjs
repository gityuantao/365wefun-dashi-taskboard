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

test("runCodex kills and reports timed-out runs", async () => {
  const child = mockChild();
  const promise = runCodex({
    workdir: "/tmp",
    prompt: "slow",
    timeoutMinutes: 0.001,
    spawnImpl: () => child,
  });
  const result = await promise;
  assert.equal(result.timedOut, true);
  assert.equal(child.killed, true);
});

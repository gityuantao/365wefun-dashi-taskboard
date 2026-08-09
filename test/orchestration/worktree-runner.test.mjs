import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertClean,
  createTaskWorktree,
  removeTaskWorktree,
  runInWorktree,
} from "../../orchestration/runner/worktree.mjs";

async function makeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktree-"));
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "Test"], { stdio: "ignore" });
  await writeFile(path.join(root, "README.md"), "base\n");
  execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "-m", "base"], { stdio: "ignore" });
  return root;
}

test("createTaskWorktree rejects unsafe task ids", async () => {
  for (const taskId of ["../escape", "a/b", "a b", ""]) {
    await assert.rejects(
      () => createTaskWorktree({ repoPath: "/tmp", taskId }),
      /INVALID_TASK_ID/,
    );
  }
});

test("createTaskWorktree creates a branch and isolated worktree", async (t) => {
  const root = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktreesRoot = path.join(root, ".wt");
  await mkdir(worktreesRoot);
  const result = await createTaskWorktree({
    repoPath: root,
    taskId: "task-abc-1",
    baseRef: "main",
    worktreesRoot,
  });
  assert.ok(result.worktreePath.includes("task-task-abc-1"));
  assert.equal(result.branch, "task/task-abc-1");
  const branches = execFileSync("git", ["-C", root, "branch", "--list"], { encoding: "utf8" });
  assert.match(branches, /task\/task-abc-1/);
  const status = runInWorktree(result.worktreePath, ["status", "--porcelain"]);
  assert.equal(status.status, 0);
  assert.equal(status.stdout, "");
});

test("createTaskWorktree rechecks fencing after reads and before worktree mutation", async () => {
  let active = true;
  let mutations = 0;
  const run = async (_command, args) => {
    if (args.includes("rev-parse")) return { status: 1, stdout: "", stderr: "" };
    if (args.includes("list")) {
      active = false;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.includes("add")) mutations += 1;
    return { status: 0, stdout: "", stderr: "" };
  };

  await assert.rejects(
    createTaskWorktree({
      repoPath: "/repo",
      taskId: "task-fenced",
      worktreesRoot: "/worktrees",
      run,
      beforeMutation: async () => {
        if (!active) throw new Error("CLAIM_MISMATCH");
      },
    }),
    /CLAIM_MISMATCH/,
  );
  assert.equal(mutations, 0);
});

test("removeTaskWorktree removes the worktree and branch", async (t) => {
  const root = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktreesRoot = path.join(root, ".wt");
  await mkdir(worktreesRoot);
  const { worktreePath, branch } = await createTaskWorktree({
    repoPath: root,
    taskId: "task-remove-1",
    baseRef: "main",
    worktreesRoot,
  });
  const result = removeTaskWorktree({
    repoPath: root,
    taskId: "task-remove-1",
    worktreesRoot,
  });
  assert.equal(result.worktreePath, worktreePath);
  assert.equal(result.branch, branch);
  assert.equal(existsSync(worktreePath), false);
  const branches = execFileSync("git", ["-C", root, "branch", "--list"], { encoding: "utf8" });
  assert.doesNotMatch(branches, /task\/task-remove-1/);
});

test("assertClean detects dirty worktrees", async (t) => {
  const root = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktreesRoot = path.join(root, ".wt");
  await mkdir(worktreesRoot);
  const { worktreePath } = await createTaskWorktree({
    repoPath: root,
    taskId: "task-clean-1",
    baseRef: "main",
    worktreesRoot,
  });
  assertClean(worktreePath);
  await writeFile(path.join(worktreePath, "change.txt"), "x\n");
  assert.throws(() => assertClean(worktreePath), /DIRTY_WORKTREE/);
});

test("runInWorktree reports non-zero exits", async (t) => {
  const root = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktreesRoot = path.join(root, ".wt");
  await mkdir(worktreesRoot);
  const { worktreePath } = await createTaskWorktree({
    repoPath: root,
    taskId: "task-fail-1",
    baseRef: "main",
    worktreesRoot,
  });
  const result = runInWorktree(worktreePath, ["log", "--definitely-not-an-option"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown option|unrecognized/i);
});

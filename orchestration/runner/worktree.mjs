import { spawnSync } from "node:child_process";
import path from "node:path";
import { DomainError } from "../domain/errors.mjs";

const TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertSafeTaskId(taskId) {
  if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) {
    throw new DomainError(
      "INVALID_TASK_ID",
      `Task id "${taskId}" contains unsafe characters`,
      { taskId },
    );
  }
}

function git(repoPath, args) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

export function createTaskWorktree({
  repoPath,
  taskId,
  baseRef = "main",
  worktreesRoot,
}) {
  assertSafeTaskId(taskId);
  const branch = `task/${taskId}`;
  const worktreePath = path.join(
    worktreesRoot ?? path.join(repoPath, ".worktrees"),
    `task-${taskId}`,
  );
  const result = git(repoPath, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
  if (result.status !== 0) {
    throw new DomainError(
      "WORKTREE_CREATE_FAILED",
      `Failed to create worktree for ${taskId}: ${result.stderr}`,
      { taskId },
    );
  }
  return { worktreePath, branch };
}

export function runInWorktree(worktreePath, args) {
  const result = git(worktreePath, args);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function assertClean(worktreePath) {
  const result = git(worktreePath, ["status", "--porcelain"]);
  if (result.status !== 0 || result.stdout.trim() !== "") {
    throw new DomainError(
      "DIRTY_WORKTREE",
      `Worktree at ${worktreePath} is not clean`,
      { worktreePath },
    );
  }
}

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
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
  const existingBranch = git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const existingWorktree = git(repoPath, ["worktree", "list", "--porcelain"]);
  if (existingWorktree.stdout.includes(`worktree ${worktreePath}`)) {
    return { worktreePath, branch, reused: true };
  }
  const result = existingBranch.status === 0
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", "-b", branch, worktreePath, baseRef];
  const finalResult = git(repoPath, result);
  if (finalResult.status !== 0) {
    throw new DomainError(
      "WORKTREE_CREATE_FAILED",
      `Failed to create worktree for ${taskId}: ${finalResult.stderr}`,
      { taskId },
    );
  }
  return { worktreePath, branch, reused: existingBranch.status === 0 };
}

export function runInWorktree(worktreePath, args) {
  const result = git(worktreePath, args);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function removeTaskWorktree({ repoPath, taskId, worktreesRoot }) {
  assertSafeTaskId(taskId);
  const branch = `task/${taskId}`;
  const worktreePath = path.join(
    worktreesRoot ?? path.join(repoPath, ".worktrees"),
    `task-${taskId}`,
  );
  const removed = git(repoPath, ["worktree", "remove", "--force", worktreePath]);
  if (removed.status !== 0 && !/not a working tree/i.test(removed.stderr)) {
    throw new DomainError(
      "WORKTREE_REMOVE_FAILED",
      `Failed to remove worktree for ${taskId}: ${removed.stderr}`,
      { taskId, stderr: removed.stderr },
    );
  }
  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }
  const branchRemoved = git(repoPath, ["branch", "-D", branch]);
  if (branchRemoved.status !== 0 && !/not found/i.test(branchRemoved.stderr)) {
    throw new DomainError(
      "BRANCH_REMOVE_FAILED",
      `Failed to remove branch ${branch}: ${branchRemoved.stderr}`,
      { branch, stderr: branchRemoved.stderr },
    );
  }
  return { worktreePath, branch };
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

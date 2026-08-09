import { spawnSync } from "node:child_process";

function git(repoPath, args) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

export function mergeTaskPrToVersionBranch({
  repoPath,
  versionBranch,
  prRef,
}) {
  const head = git(repoPath, ["rev-parse", "--verify", prRef]);
  if (head.status !== 0) {
    return { merged: false, conflict: false, error: head.stderr };
  }
  const taskHead = head.stdout.trim();
  const checkout = git(repoPath, ["checkout", versionBranch]);
  if (checkout.status !== 0) {
    return { merged: false, conflict: false, error: checkout.stderr };
  }
  const merge = git(repoPath, [
    "merge",
    "--no-ff",
    prRef,
    "-m",
    `Merge task PR ${prRef}`,
  ]);
  if (merge.status !== 0) {
    git(repoPath, ["merge", "--abort"]);
    return {
      merged: false,
      conflict: true,
      taskHead,
      error: merge.stderr,
    };
  }
  const candidate = git(repoPath, ["rev-parse", "HEAD"]);
  if (candidate.status !== 0) {
    return { merged: false, conflict: false, taskHead, error: candidate.stderr };
  }
  return {
    merged: true,
    versionBranch,
    taskHead,
    candidateCommit: candidate.stdout.trim(),
  };
}

export function verifyCandidateIntegration({
  repoPath,
  versionBranch,
  candidateCommit,
  taskPrHeads,
}) {
  const branchHead = git(repoPath, ["rev-parse", "--verify", versionBranch]);
  if (branchHead.status !== 0 || branchHead.stdout.trim() !== candidateCommit) {
    return { verified: false, error: "version branch does not point to frozen Candidate" };
  }
  for (const head of taskPrHeads) {
    const ancestor = git(repoPath, ["merge-base", "--is-ancestor", head.headCommit, candidateCommit]);
    if (ancestor.status !== 0) {
      return { verified: false, error: `task PR head ${head.taskId} is not integrated` };
    }
  }
  return { verified: true };
}

import { spawnSync } from "node:child_process";
import { classifyChangedPaths } from "./path-classification.mjs";

const SHA = /^[0-9a-f]{40}$/i;

function fail(message) {
  throw new Error(`Candidate scope closed: ${message}`);
}

function defaultRunGit(repoPath, args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function run(repoPath, args, runGit) {
  const result = runGit(repoPath, args);
  if (!result || typeof result.status !== "number") fail("git runner returned an invalid result");
  return result;
}

function verifyCommit(repoPath, commit, runGit, label) {
  if (!SHA.test(commit ?? "")) fail(`${label} commit is invalid`);
  const result = run(repoPath, ["rev-parse", "--verify", `${commit}^{commit}`], runGit);
  if (result.status !== 0 || result.stdout.trim().toLowerCase() !== commit.toLowerCase()) {
    fail(`${label} commit is missing`);
  }
}

export function classifyCandidateChanges({ repoPath, baseCommit, candidateCommit, runGit = defaultRunGit }) {
  if (typeof repoPath !== "string" || repoPath.trim() === "") fail("repository path is missing");
  verifyCommit(repoPath, baseCommit, runGit, "base");
  verifyCommit(repoPath, candidateCommit, runGit, "candidate");
  if (run(repoPath, ["merge-base", "--is-ancestor", baseCommit, candidateCommit], runGit).status !== 0) {
    fail("base commit is not an ancestor of Candidate commit");
  }
  const diff = run(repoPath, ["diff", "--name-only", "-z", baseCommit, candidateCommit], runGit);
  if (diff.status !== 0) fail("Candidate diff could not be read");
  const changedPaths = [...new Set(diff.stdout.split("\0").map((value) => value.trim()).filter(Boolean))].sort();
  const scope = classifyChangedPaths(changedPaths);
  return {
    baseCommit,
    candidateCommit,
    mappingVersion: 1,
    changedPaths,
    platforms: scope.platforms,
    unsupported: scope.unsupported,
  };
}

import { spawnSync } from "node:child_process";

function git(repoPath, args) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

export function mergeTaskPrToVersionBranch({
  repoPath,
  versionBranch,
  prRef,
}) {
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
    return { merged: false, conflict: true, stderr: merge.stderr };
  }
  return { merged: true };
}

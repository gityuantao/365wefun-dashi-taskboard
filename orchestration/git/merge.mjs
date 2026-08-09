import { spawnSync } from "node:child_process";

function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(repoPath, args, run = runCommand) {
  return run("git", ["-C", repoPath, ...args]);
}

function pullRequestNumber(value) {
  const match = String(value ?? "").match(/(?:\/pull\/)?(\d+)\/?$/);
  return match ? Number(match[1]) : null;
}

function githubPullRequest({ repository, pullRequest, versionBranch, run }) {
  const number = pullRequestNumber(pullRequest);
  if (!number) {
    return { ok: false, error: "task has no recorded GitHub pull request" };
  }
  const viewed = run("gh", [
    "pr", "view", String(number),
    "--repo", repository,
    "--json", "number,state,baseRefName,headRefName,headRefOid",
  ]);
  if (viewed.status !== 0) {
    return { ok: false, error: viewed.stderr || "GitHub PR lookup failed" };
  }
  let pr;
  try {
    pr = JSON.parse(viewed.stdout);
  } catch {
    return { ok: false, error: "GitHub PR lookup returned invalid JSON" };
  }
  if (pr.number !== number || pr.state !== "OPEN" || pr.baseRefName !== versionBranch) {
    return { ok: false, error: "GitHub PR is not open against the version branch" };
  }
  if (!/^[0-9a-f]{40,64}$/i.test(pr.headRefOid ?? "")) {
    return { ok: false, error: "GitHub PR head commit is invalid" };
  }
  return { ok: true, ...pr };
}

export function mergeTaskPrToVersionBranch({
  repoPath,
  versionBranch,
  prRef,
  run = runCommand,
}) {
  const head = git(repoPath, ["rev-parse", "--verify", prRef], run);
  if (head.status !== 0) {
    return { merged: false, conflict: false, error: head.stderr };
  }
  const taskHead = head.stdout.trim();
  const checkout = git(repoPath, ["checkout", versionBranch], run);
  if (checkout.status !== 0) {
    return { merged: false, conflict: false, error: checkout.stderr };
  }
  const merge = git(repoPath, [
    "merge",
    "--no-ff",
    prRef,
    "-m",
    `Merge task PR ${prRef}`,
  ], run);
  if (merge.status !== 0) {
    git(repoPath, ["merge", "--abort"], run);
    return {
      merged: false,
      conflict: true,
      taskHead,
      error: merge.stderr,
    };
  }
  const candidate = git(repoPath, ["rev-parse", "HEAD"], run);
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

export function fetchAndMergeTaskPullRequest({
  repoPath,
  repository,
  taskId,
  pullRequest,
  versionBranch,
  run = runCommand,
}) {
  const pr = githubPullRequest({ repository, pullRequest, versionBranch, run });
  if (!pr.ok) return { merged: false, conflict: false, error: pr.error };
  const refreshedBase = git(repoPath, [
    "fetch", "--force", "origin",
    `refs/heads/${versionBranch}:refs/heads/${versionBranch}`,
  ], run);
  if (refreshedBase.status !== 0) {
    return {
      merged: false,
      conflict: false,
      error: refreshedBase.stderr || "version branch refresh failed",
    };
  }
  const fetchedRef = `refs/taskboard/pull/${pr.number}/${pr.headRefOid}`;
  const fetched = git(repoPath, [
    "fetch", "--force", "origin",
    `refs/pull/${pr.number}/head:${fetchedRef}`,
  ], run);
  if (fetched.status !== 0) {
    return { merged: false, conflict: false, error: fetched.stderr || "GitHub PR fetch failed" };
  }
  const fetchedHead = git(repoPath, ["rev-parse", "--verify", fetchedRef], run);
  if (fetchedHead.status !== 0 || fetchedHead.stdout.trim() !== pr.headRefOid) {
    return { merged: false, conflict: false, error: "fetched PR head is stale" };
  }
  const merged = mergeTaskPrToVersionBranch({
    repoPath,
    versionBranch,
    prRef: fetchedRef,
    run,
  });
  return {
    ...merged,
    taskId,
    repository,
    prNumber: pr.number,
    headRefName: pr.headRefName,
    fetchedRef,
  };
}

export function verifyCandidateIntegration({
  repoPath,
  repository,
  versionBranch,
  candidateCommit,
  candidateRef = null,
  taskPrHeads,
  run = runCommand,
}) {
  const branchHead = git(repoPath, ["rev-parse", "--verify", versionBranch], run);
  if (branchHead.status !== 0 || branchHead.stdout.trim() !== candidateCommit) {
    return { verified: false, error: "version branch does not point to frozen Candidate" };
  }
  for (const head of taskPrHeads) {
    const ancestor = git(repoPath, ["merge-base", "--is-ancestor", head.headCommit, candidateCommit], run);
    if (ancestor.status !== 0) {
      return { verified: false, error: `task PR head ${head.taskId} is not integrated` };
    }
    if (head.prNumber) {
      const remote = run("gh", [
        "pr", "view", String(head.prNumber),
        "--repo", head.repository ?? repository,
        "--json", "headRefOid,state",
      ]);
      if (remote.status !== 0) {
        return { verified: false, error: `GitHub PR ${head.prNumber} readback failed` };
      }
      let pr;
      try {
        pr = JSON.parse(remote.stdout);
      } catch {
        return { verified: false, error: `GitHub PR ${head.prNumber} readback is invalid` };
      }
      if (pr.headRefOid !== head.headCommit) {
        return { verified: false, error: `GitHub PR ${head.prNumber} head changed` };
      }
    }
  }
  if (candidateRef) {
    const remoteCandidate = git(repoPath, ["ls-remote", "origin", candidateRef], run);
    const remoteVersion = git(repoPath, ["ls-remote", "origin", `refs/heads/${versionBranch}`], run);
    if (
      remoteCandidate.status !== 0
      || remoteCandidate.stdout.trim().split(/\s+/)[0] !== candidateCommit
      || remoteVersion.status !== 0
      || remoteVersion.stdout.trim().split(/\s+/)[0] !== candidateCommit
    ) {
      return { verified: false, error: "remote Candidate ref does not match frozen Candidate" };
    }
  }
  return { verified: true };
}

export function pushCandidateToRemote({
  repoPath,
  versionId,
  versionBranch,
  candidateCommit,
  run = runCommand,
}) {
  const safeVersionId = String(versionId).replace(/[^A-Za-z0-9._-]/g, "-");
  const candidateRef = `refs/heads/release-candidate/${safeVersionId}/${candidateCommit}`;
  const candidatePush = git(repoPath, ["push", "origin", `${candidateCommit}:${candidateRef}`], run);
  if (candidatePush.status !== 0) {
    return { persisted: false, error: candidatePush.stderr || "Candidate ref push failed" };
  }
  const versionPush = git(
    repoPath,
    ["push", "origin", `${candidateCommit}:refs/heads/${versionBranch}`],
    run,
  );
  if (versionPush.status !== 0) {
    return { persisted: false, candidateRef, error: versionPush.stderr || "version branch push failed" };
  }
  const candidateReadback = git(repoPath, ["ls-remote", "origin", candidateRef], run);
  const versionReadback = git(repoPath, ["ls-remote", "origin", `refs/heads/${versionBranch}`], run);
  if (
    candidateReadback.stdout.trim().split(/\s+/)[0] !== candidateCommit
    || versionReadback.stdout.trim().split(/\s+/)[0] !== candidateCommit
  ) {
    return { persisted: false, candidateRef, error: "remote Candidate readback mismatch" };
  }
  return { persisted: true, candidateRef, remoteCandidateCommit: candidateCommit };
}

export function createReleaseGitOps({ repoPath, repository, run = runCommand }) {
  return {
    integrateTaskPr: ({ taskId, pullRequest, versionBranch }) => fetchAndMergeTaskPullRequest({
      repoPath,
      repository,
      taskId,
      pullRequest,
      versionBranch,
      run,
    }),
    persistCandidate: ({ versionId, versionBranch, candidateCommit, taskPrHeads }) => {
      const verified = verifyCandidateIntegration({
        repoPath,
        repository,
        versionBranch,
        candidateCommit,
        taskPrHeads,
        run,
      });
      if (!verified.verified) return { persisted: false, error: verified.error };
      const persisted = pushCandidateToRemote({
        repoPath,
        versionId,
        versionBranch,
        candidateCommit,
        run,
      });
      if (!persisted.persisted) return persisted;
      const remoteVerified = verifyCandidateIntegration({
        repoPath,
        repository,
        versionBranch,
        candidateCommit,
        candidateRef: persisted.candidateRef,
        taskPrHeads,
        run,
      });
      return remoteVerified.verified
        ? persisted
        : { persisted: false, candidateRef: persisted.candidateRef, error: remoteVerified.error };
    },
    verifyCandidate: ({ manifest }) => verifyCandidateIntegration({
      repoPath,
      repository,
      versionBranch: manifest.versionBranch,
      candidateCommit: manifest.candidateCommit,
      candidateRef: manifest.candidateRef,
      taskPrHeads: manifest.taskPrHeads,
      run,
    }),
  };
}

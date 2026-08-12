import { spawnSync } from "node:child_process";
import { redactCredentials } from "../domain/redaction.mjs";

function boundedDiagnostic(...values) {
  return redactCredentials(values.filter(Boolean).join("\n"))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 4000);
}

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
    "--json", "number,state,baseRefName,headRefName,headRefOid,mergeCommit",
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
  if (pr.number !== number || !["OPEN", "MERGED"].includes(pr.state) || pr.baseRefName !== versionBranch) {
    return { ok: false, error: "GitHub PR is not open or merged against the version branch" };
  }
  if (!/^[0-9a-f]{40,64}$/i.test(pr.headRefOid ?? "")) {
    return { ok: false, error: "GitHub PR head commit is invalid" };
  }
  return { ok: true, ...pr };
}

export function mergeTaskPrToVersionBranch({
  repoPath,
  versionBranch,
  baseRef = versionBranch,
  prRef,
  run = runCommand,
}) {
  const head = git(repoPath, ["rev-parse", "--verify", prRef], run);
  if (head.status !== 0) {
    return { merged: false, conflict: false, error: head.stderr };
  }
  const taskHead = head.stdout.trim();
  const original = git(repoPath, ["symbolic-ref", "--short", "-q", "HEAD"], run);
  const originalRef = original.status === 0 ? original.stdout.trim() : null;
  const checkout = git(repoPath, ["checkout", "--detach", baseRef], run);
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
    const unmerged = git(repoPath, ["diff", "--name-only", "--diff-filter=U"], run);
    const conflictedPaths = unmerged.status === 0
      ? [...new Set(unmerged.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))].sort()
      : [];
    const error = boundedDiagnostic(merge.stdout, merge.stderr)
      || "task PR merge failed without diagnostic output";
    git(repoPath, ["merge", "--abort"], run);
    if (originalRef) git(repoPath, ["checkout", originalRef], run);
    return {
      merged: false,
      conflict: true,
      ...(conflictedPaths.length > 0
        ? { classification: "merge_conflict", conflictedPaths }
        : {}),
      taskHead,
      error,
    };
  }
  const candidate = git(repoPath, ["rev-parse", "HEAD"], run);
  if (candidate.status !== 0) {
    return { merged: false, conflict: false, taskHead, error: candidate.stderr };
  }
  const candidateCommit = candidate.stdout.trim();
  const updateBranch = git(repoPath, ["branch", "--force", versionBranch, candidateCommit], run);
  if (updateBranch.status !== 0) {
    if (originalRef) git(repoPath, ["checkout", originalRef], run);
    return { merged: false, conflict: false, taskHead, error: updateBranch.stderr };
  }
  if (originalRef) {
    const restore = git(repoPath, ["checkout", originalRef], run);
    if (restore.status !== 0) {
      return { merged: false, conflict: false, taskHead, error: restore.stderr };
    }
  }
  return {
    merged: true,
    versionBranch,
    taskHead,
    candidateCommit,
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
  if (pr.state === "MERGED") {
    const taskHead = pr.headRefOid;
    const mergeCommit = pr.mergeCommit?.oid;
    if (
      !/^[0-9a-f]{40,64}$/i.test(taskHead ?? "")
      || !/^[0-9a-f]{40,64}$/i.test(mergeCommit ?? "")
    ) {
      return { merged: false, conflict: false, error: "merged GitHub PR has no valid merge commit" };
    }
    const fetchedBase = `refs/taskboard/base/${versionBranch}`;
    const refreshedBase = git(repoPath, [
      "fetch", "--force", "origin",
      `refs/heads/${versionBranch}:${fetchedBase}`,
    ], run);
    if (refreshedBase.status !== 0) {
      return {
        merged: false,
        conflict: false,
        error: refreshedBase.stderr || "version branch refresh failed",
      };
    }
    const taskHeadContained = git(
      repoPath,
      ["merge-base", "--is-ancestor", taskHead, fetchedBase],
      run,
    );
    if (taskHeadContained.status !== 0) {
      return { merged: false, conflict: false, error: "merged PR head is not contained in refreshed version history" };
    }
    const mergeCommitContained = git(
      repoPath,
      ["merge-base", "--is-ancestor", mergeCommit, fetchedBase],
      run,
    );
    if (mergeCommitContained.status !== 0) {
      return { merged: false, conflict: false, error: "merged PR commit is not contained in refreshed version history" };
    }
    const refreshedHead = git(repoPath, ["rev-parse", fetchedBase], run);
    if (refreshedHead.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(refreshedHead.stdout.trim())) {
      return { merged: false, conflict: false, error: "refreshed version branch head is invalid" };
    }
    const candidateCommit = refreshedHead.stdout.trim();
    return {
      merged: true,
      taskId,
      repository,
      prNumber: pr.number,
      headRefName: pr.headRefName,
      taskHead: pr.headRefOid,
      candidateCommit,
      candidateBaseCommit: candidateCommit,
      candidateSourceRef: fetchedBase,
      versionBranch,
      alreadyMerged: true,
    };
  }
  const fetchedBase = `refs/taskboard/base/${versionBranch}`;
  const refreshedBase = git(repoPath, [
    "fetch", "--force", "origin",
    `refs/heads/${versionBranch}:${fetchedBase}`,
  ], run);
  if (refreshedBase.status !== 0) {
    return {
      merged: false,
      conflict: false,
      error: refreshedBase.stderr || "version branch refresh failed",
    };
  }
  const baseHead = git(repoPath, ["rev-parse", "--verify", fetchedBase], run);
  if (baseHead.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(baseHead.stdout.trim())) {
    return { merged: false, conflict: false, error: "version branch base commit is invalid" };
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
    baseRef: fetchedBase,
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
    candidateSourceRef: versionBranch,
    candidateBaseCommit: baseHead.stdout.trim(),
  };
}

export function verifyCandidateIntegration({
  repoPath,
  repository,
  versionBranch,
  candidateCommit,
  candidateSourceRef = null,
  candidateRef = null,
  taskPrHeads,
  run = runCommand,
}) {
  if (!candidateRef) {
    const sourceRef = candidateSourceRef ?? versionBranch;
    const branchHead = git(repoPath, ["rev-parse", "--verify", sourceRef], run);
    if (branchHead.status !== 0 || branchHead.stdout.trim() !== candidateCommit) {
      return { verified: false, error: "Candidate source ref does not point to frozen Candidate" };
    }
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
    persistCandidate: ({
      versionId,
      versionBranch,
      candidateCommit,
      candidateSourceRef,
      taskPrHeads,
    }) => {
      const verified = verifyCandidateIntegration({
        repoPath,
        repository,
        versionBranch,
        candidateCommit,
        candidateSourceRef,
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

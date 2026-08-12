import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createReleaseGitOps,
  fetchAndMergeTaskPullRequest,
  mergeTaskPrToVersionBranch,
  resolveCandidateBase,
  verifyCandidateIntegration,
} from "../../orchestration/git/merge.mjs";

function git(repoPath, args) {
  return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function makeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-merge-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "file.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  git(root, ["branch", "version/v-1"]);
  return root;
}

async function makeMergedPullRequestRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-merged-pr-"));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  git(root, ["init", "--bare", remote]);
  git(root, ["init", "-b", "main", repo]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["remote", "add", "origin", remote]);
  await writeFile(path.join(repo, "file.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["checkout", "-b", "version/v-1"]);
  git(repo, ["push", "origin", "version/v-1"]);
  git(repo, ["checkout", "-b", "task/task-1"]);
  await writeFile(path.join(repo, "feature.txt"), "feature\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feature"]);
  const headRefOid = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["checkout", "version/v-1"]);
  git(repo, ["merge", "--no-ff", "task/task-1", "-m", "Merge task PR"]);
  const mergeCommit = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["push", "origin", "version/v-1"]);
  return { root, remote, repo, headRefOid, mergeCommit };
}

function mergedPullRequestRun({ headRefOid, mergeCommit }) {
  return (command, args) => {
    if (command === "gh") {
      return {
        status: 0,
        stdout: JSON.stringify({
          number: 42,
          state: "MERGED",
          baseRefName: "version/v-1",
          headRefName: "task/task-1",
          headRefOid,
          mergeCommit: { oid: mergeCommit },
        }),
        stderr: "",
      };
    }
    try {
      return { status: 0, stdout: execFileSync(command, args, { encoding: "utf8" }), stderr: "" };
    } catch (error) {
      return {
        status: error.status ?? 1,
        stdout: error.stdout?.toString() ?? "",
        stderr: error.stderr?.toString() ?? "",
      };
    }
  };
}

test("fetchAndMergeTaskPullRequest accepts a merged PR whose merge commit equals remote HEAD", async (t) => {
  const { root, repo, headRefOid, mergeCommit } = await makeMergedPullRequestRepo();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = fetchAndMergeTaskPullRequest({
    repoPath: repo,
    repository: "owner/repo",
    taskId: "task-1",
    pullRequest: "https://github.com/owner/repo/pull/42",
    versionBranch: "version/v-1",
    run: mergedPullRequestRun({ headRefOid, mergeCommit }),
  });

  assert.equal(result.merged, true);
  assert.equal(result.taskHead, headRefOid);
  assert.equal(result.candidateCommit, mergeCommit);
  assert.equal(result.alreadyMerged, true);
});

test("fetchAndMergeTaskPullRequest accepts a merged PR ancestor of a later remote HEAD", async (t) => {
  const { root, repo, headRefOid, mergeCommit } = await makeMergedPullRequestRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(repo, "later.txt"), "later\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "later version work"]);
  git(repo, ["push", "origin", "version/v-1"]);
  const laterRemoteHead = git(repo, ["rev-parse", "HEAD"]).trim();

  const result = fetchAndMergeTaskPullRequest({
    repoPath: repo,
    repository: "owner/repo",
    taskId: "task-1",
    pullRequest: "https://github.com/owner/repo/pull/42",
    versionBranch: "version/v-1",
    run: mergedPullRequestRun({ headRefOid, mergeCommit }),
  });

  assert.equal(result.merged, true);
  assert.equal(result.taskHead, headRefOid);
  assert.equal(result.candidateCommit, laterRemoteHead);
  assert.equal(result.alreadyMerged, true);
});

test("production git ops persist a merged remote Candidate without mutating a stale local version branch", async (t) => {
  const { root, remote, repo, headRefOid, mergeCommit } = await makeMergedPullRequestRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const publisher = path.join(root, "publisher");
  git(root, ["clone", remote, publisher]);
  git(publisher, ["config", "user.email", "publisher@example.com"]);
  git(publisher, ["config", "user.name", "Publisher"]);
  git(publisher, ["checkout", "version/v-1"]);
  await writeFile(path.join(publisher, "later.txt"), "later remote work\n");
  git(publisher, ["add", "."]);
  git(publisher, ["commit", "-m", "later remote version work"]);
  git(publisher, ["push", "origin", "version/v-1"]);
  const remoteHead = git(publisher, ["rev-parse", "HEAD"]).trim();
  assert.equal(git(repo, ["rev-parse", "version/v-1"]).trim(), mergeCommit);

  const ops = createReleaseGitOps({
    repoPath: repo,
    repository: "owner/repo",
    run: mergedPullRequestRun({ headRefOid, mergeCommit }),
  });
  const integrated = await ops.integrateTaskPr({
    taskId: "task-1",
    pullRequest: "https://github.com/owner/repo/pull/42",
    versionBranch: "version/v-1",
  });
  assert.equal(integrated.merged, true);
  assert.equal(integrated.candidateCommit, remoteHead);
  assert.notEqual(integrated.candidateBaseCommit, integrated.candidateCommit);
  assert.equal(git(repo, ["rev-parse", "version/v-1"]).trim(), mergeCommit);

  const persisted = await ops.persistCandidate({
    versionId: "v-1",
    versionBranch: "version/v-1",
    candidateCommit: integrated.candidateCommit,
    candidateSourceRef: integrated.candidateSourceRef,
    taskPrHeads: [{
      taskId: "task-1",
      headCommit: integrated.taskHead,
      prNumber: integrated.prNumber,
      repository: integrated.repository,
    }],
  });

  assert.equal(persisted.persisted, true, persisted.error);
  assert.equal(git(repo, ["rev-parse", "version/v-1"]).trim(), mergeCommit);
  assert.equal(
    git(repo, ["ls-remote", "origin", persisted.candidateRef]).trim().split(/\s+/)[0],
    remoteHead,
  );
});

test("fetchAndMergeTaskPullRequest rejects merged PR SHAs absent from refreshed version history", async (t) => {
  const { root, repo, headRefOid, mergeCommit } = await makeMergedPullRequestRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  git(repo, ["checkout", "-b", "unrelated", "main"]);
  await writeFile(path.join(repo, "unrelated.txt"), "unrelated\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "unrelated work"]);
  const unrelatedCommit = git(repo, ["rev-parse", "HEAD"]).trim();

  const absentHead = fetchAndMergeTaskPullRequest({
    repoPath: repo,
    repository: "owner/repo",
    taskId: "task-1",
    pullRequest: "https://github.com/owner/repo/pull/42",
    versionBranch: "version/v-1",
    run: mergedPullRequestRun({ headRefOid: unrelatedCommit, mergeCommit }),
  });
  assert.equal(absentHead.merged, false);

  const absentMerge = fetchAndMergeTaskPullRequest({
    repoPath: repo,
    repository: "owner/repo",
    taskId: "task-1",
    pullRequest: "https://github.com/owner/repo/pull/42",
    versionBranch: "version/v-1",
    run: mergedPullRequestRun({ headRefOid, mergeCommit: unrelatedCommit }),
  });
  assert.equal(absentMerge.merged, false);
});

test("mergeTaskPrToVersionBranch merges with history preserved", async (t) => {
  const root = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ["checkout", "-b", "task/task-1"]);
  await writeFile(path.join(root, "feature.txt"), "feature\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "feature work"]);
  const taskSha = git(root, ["rev-parse", "HEAD"]).trim();

  const result = mergeTaskPrToVersionBranch({
    repoPath: root,
    versionBranch: "version/v-1",
    prRef: "task/task-1",
  });
  assert.equal(result.merged, true);
  assert.equal(result.taskHead, taskSha);
  const mergedSha = git(root, ["rev-parse", "version/v-1"]).trim();
  assert.equal(result.candidateCommit, mergedSha);
  assert.equal(result.versionBranch, "version/v-1");
  assert.notEqual(mergedSha, taskSha);
  const parents = git(root, ["log", "--format=%P", "-1", mergedSha]).trim().split(/\s+/);
  assert.equal(parents.length, 2, "merge commit must preserve both parents");
  assert.equal(verifyCandidateIntegration({
    repoPath: root,
    versionBranch: "version/v-1",
    candidateCommit: mergedSha,
    taskPrHeads: [{ taskId: "task-1", headCommit: taskSha }],
  }).verified, true);
});

test("mergeTaskPrToVersionBranch reports conflicts without resolving", async (t) => {
  const root = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ["checkout", "version/v-1"]);
  await writeFile(path.join(root, "file.txt"), "version change\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "version change"]);

  git(root, ["checkout", "-b", "task/task-2", "main"]);
  await writeFile(path.join(root, "file.txt"), "task change\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "task change"]);

  const result = mergeTaskPrToVersionBranch({
    repoPath: root,
    versionBranch: "version/v-1",
    prRef: "task/task-2",
  });
  assert.equal(result.merged, false);
  assert.equal(result.conflict, true);
  assert.equal(result.classification, "merge_conflict");
  assert.deepEqual(result.conflictedPaths, ["file.txt"]);
  assert.match(result.error, /CONFLICT|file\.txt/);
  assert.equal(git(root, ["status", "--porcelain"]).trim(), "");
});

test("Candidate base is order-independent across merged and open task integration anchors", async (t) => {
  const root = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = git(root, ["rev-parse", "main"]).trim();
  git(root, ["checkout", "version/v-1"]);
  await writeFile(path.join(root, "apps-mp.txt"), "merged\n");
  git(root, ["add", "."]); git(root, ["commit", "-m", "merged task"]);
  const mergedBase = git(root, ["rev-parse", "HEAD^" ]).trim();
  git(root, ["checkout", "-b", "task/open", original]);
  await writeFile(path.join(root, "apps-web.txt"), "open\n");
  git(root, ["add", "."]); git(root, ["commit", "-m", "open task"]);
  const merged = mergeTaskPrToVersionBranch({ repoPath: root, versionBranch: "version/v-1", prRef: "task/open" });
  const forward = resolveCandidateBase({ repoPath: root, candidateCommit: merged.candidateCommit, candidateBaseCommits: [mergedBase, original] });
  const reversed = resolveCandidateBase({ repoPath: root, candidateCommit: merged.candidateCommit, candidateBaseCommits: [original, mergedBase] });
  assert.deepEqual(forward, reversed);
  assert.equal(forward.candidateBaseCommit, original);
  assert.deepEqual(git(root, ["diff", "--name-only", forward.candidateBaseCommit, merged.candidateCommit]).trim().split("\n").sort(), ["apps-mp.txt", "apps-web.txt"]);
});

test("mixed open and merged PR integration preserves every change in either task order", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-mixed-pr-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  git(root, ["init", "--bare", remote]);
  git(root, ["init", "-b", "main", seed]);
  git(seed, ["config", "user.email", "test@example.com"]);
  git(seed, ["config", "user.name", "Test"]);
  git(seed, ["remote", "add", "origin", remote]);
  await writeFile(path.join(seed, "base.txt"), "base\n");
  git(seed, ["add", "."]); git(seed, ["commit", "-m", "base"]);
  const initialBase = git(seed, ["rev-parse", "HEAD"]).trim();
  git(seed, ["checkout", "-b", "version/v-1"]); git(seed, ["push", "origin", "version/v-1"]);
  git(seed, ["checkout", "-b", "task/merged"]);
  await mkdir(path.join(seed, "apps/mp"), { recursive: true });
  await writeFile(path.join(seed, "apps/mp/merged.mjs"), "merged\n", { recursive: true });
  git(seed, ["add", "."]); git(seed, ["commit", "-m", "merged task"]);
  const mergedHead = git(seed, ["rev-parse", "HEAD"]).trim();
  git(seed, ["checkout", "version/v-1"]); git(seed, ["merge", "--no-ff", "task/merged", "-m", "merge task"]);
  const mergedCommit = git(seed, ["rev-parse", "HEAD"]).trim();
  git(seed, ["push", "origin", "version/v-1"]);
  git(seed, ["checkout", "-b", "task/open"]);
  await mkdir(path.join(seed, "apps/web"), { recursive: true });
  await writeFile(path.join(seed, "apps/web/open.mjs"), "open\n");
  git(seed, ["add", "."]); git(seed, ["commit", "-m", "open task"]);
  const openHead = git(seed, ["rev-parse", "HEAD"]).trim();
  git(seed, ["push", "origin", "HEAD:refs/pull/43/head"]);

  const run = (command, args) => {
    if (command === "gh") {
      const number = Number(args[args.indexOf("view") + 1]);
      const merged = number === 42;
      return { status: 0, stderr: "", stdout: JSON.stringify({
        number, state: merged ? "MERGED" : "OPEN", baseRefName: "version/v-1",
        headRefName: merged ? "task/merged" : "task/open",
        headRefOid: merged ? mergedHead : openHead,
        ...(merged ? { mergeCommit: { oid: mergedCommit } } : {}),
      }) };
    }
    try { return { status: 0, stdout: execFileSync(command, args, { encoding: "utf8" }), stderr: "" }; }
    catch (error) { return { status: error.status ?? 1, stdout: error.stdout?.toString() ?? "", stderr: error.stderr?.toString() ?? "" }; }
  };
  const integrate = async (order) => {
    const repo = path.join(root, `repo-${order.join("-")}`);
    git(root, ["clone", remote, repo]);
    git(repo, ["config", "user.email", "test@example.com"]); git(repo, ["config", "user.name", "Test"]);
    git(repo, ["checkout", "version/v-1"]);
    const ops = createReleaseGitOps({ repoPath: repo, repository: "owner/repo", run });
    const results = [];
    for (const number of order) results.push(await ops.integrateTaskPr({
      taskId: `task-${number}`, pullRequest: `https://github.com/owner/repo/pull/${number}`, versionBranch: "version/v-1",
    }));
    const candidate = results.at(-1).candidateCommit;
    const base = ops.resolveCandidateBase({ candidateCommit: candidate, candidateBaseCommits: results.map((result) => result.candidateBaseCommit) });
    return {
      paths: git(repo, ["diff", "--name-only", base.candidateBaseCommit, candidate]).trim().split("\n").filter(Boolean).sort(),
      base: base.candidateBaseCommit,
    };
  };

  const openThenMerged = await integrate([43, 42]);
  const mergedThenOpen = await integrate([42, 43]);
  assert.equal(openThenMerged.base, initialBase);
  assert.deepEqual(openThenMerged, mergedThenOpen);
  assert.deepEqual(openThenMerged.paths, ["apps/mp/merged.mjs", "apps/web/open.mjs"]);
});

test("production release git ops fetch the exact GitHub PR head and persist a remote Candidate ref", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-release-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  git(root, ["init", "--bare", remote]);
  git(root, ["init", "-b", "main", repo]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["remote", "add", "origin", remote]);
  await writeFile(path.join(repo, "file.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["push", "origin", "main"]);
  git(repo, ["checkout", "-b", "version/v-1"]);
  git(repo, ["push", "origin", "version/v-1"]);
  git(repo, ["checkout", "-b", "local-name-does-not-match-pr", "main"]);
  await writeFile(path.join(repo, "feature.txt"), "feature\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feature"]);
  const prHead = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["push", "origin", `HEAD:refs/pull/42/head`]);

  let githubHead = prHead;
  const run = (command, args) => {
    if (command === "gh") {
      return {
        status: 0,
        stdout: JSON.stringify({
          number: 42,
          state: "OPEN",
          baseRefName: "version/v-1",
          headRefName: "remote-feature-name",
          headRefOid: githubHead,
        }),
        stderr: "",
      };
    }
    const result = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: result, stderr: "" };
  };
  const ops = createReleaseGitOps({ repoPath: repo, repository: "owner/repo", run });
  const integrated = await ops.integrateTaskPr({
    taskId: "task-a",
    pullRequest: "https://github.com/owner/repo/pull/42",
    versionBranch: "version/v-1",
  });
  assert.equal(integrated.merged, true);
  assert.equal(integrated.taskHead, prHead);
  assert.equal(integrated.headRefName, "remote-feature-name");
  assert.equal(integrated.prNumber, 42);

  const persisted = await ops.persistCandidate({
    versionId: "v-1",
    versionBranch: "version/v-1",
    candidateCommit: integrated.candidateCommit,
    taskPrHeads: [{
      taskId: "task-a",
      branch: integrated.headRefName,
      headCommit: integrated.taskHead,
      prNumber: integrated.prNumber,
      repository: integrated.repository,
    }],
  });
  assert.equal(persisted.persisted, true);
  assert.equal(
    git(repo, ["ls-remote", "origin", persisted.candidateRef]).trim().split(/\s+/)[0],
    integrated.candidateCommit,
  );

  githubHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const verified = await ops.verifyCandidate({
    manifest: {
      versionBranch: "version/v-1",
      candidateCommit: integrated.candidateCommit,
      candidateRef: persisted.candidateRef,
      taskPrHeads: [{
        taskId: "task-a",
        branch: integrated.headRefName,
        headCommit: integrated.taskHead,
        prNumber: 42,
        repository: "owner/repo",
      }],
    },
  });
  assert.equal(verified.verified, false);
  assert.match(verified.error, /head changed/i);
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createReleaseGitOps,
  mergeTaskPrToVersionBranch,
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
  assert.equal(git(root, ["status", "--porcelain"]).trim(), "");
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

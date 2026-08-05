import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mergeTaskPrToVersionBranch } from "../../orchestration/git/merge.mjs";

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
  const mergedSha = git(root, ["rev-parse", "HEAD"]).trim();
  assert.notEqual(mergedSha, taskSha);
  const parents = git(root, ["log", "--format=%P", "-1"]).trim().split(/\s+/);
  assert.equal(parents.length, 2, "merge commit must preserve both parents");
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
});

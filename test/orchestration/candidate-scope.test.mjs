import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { classifyCandidateChanges } from "../../orchestration/release/candidate-scope.mjs";

function git(repoPath, args) {
  return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function createRepository(t) {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-scope-"));
  t.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  git(repoPath, ["init", "--quiet"]);
  git(repoPath, ["config", "user.email", "test@example.invalid"]);
  git(repoPath, ["config", "user.name", "Candidate Scope Test"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "base\n");
  git(repoPath, ["add", "README.md"]);
  git(repoPath, ["commit", "--quiet", "-m", "base"]);
  return {
    repoPath,
    baseCommit: git(repoPath, ["rev-parse", "HEAD"]),
    commit(paths) {
      for (const changedPath of paths) {
        const fullPath = path.join(repoPath, changedPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, `${changedPath}\n`);
      }
      git(repoPath, ["add", "."]);
      git(repoPath, ["commit", "--quiet", "-m", "candidate"]);
      return git(repoPath, ["rev-parse", "HEAD"]);
    },
  };
}

test("classifies exact Candidate paths into supported platform targets", (t) => {
  const repository = createRepository(t);
  const candidateCommit = repository.commit([
    "apps/mp/pages/index.ts",
    "apps/ios/App.swift",
    "services/api/routes.js",
    "database/migrations/001.sql",
    "apps/web/src/App.tsx",
    "apps/android-web-wrapper/src/Main.kt",
  ]);

  const scope = classifyCandidateChanges({
    repoPath: repository.repoPath,
    baseCommit: repository.baseCommit,
    candidateCommit,
  });

  assert.deepEqual(scope, {
    baseCommit: repository.baseCommit,
    candidateCommit,
    mappingVersion: 1,
    changedPaths: [
      "apps/android-web-wrapper/src/Main.kt",
      "apps/ios/App.swift",
      "apps/mp/pages/index.ts",
      "apps/web/src/App.tsx",
      "database/migrations/001.sql",
      "services/api/routes.js",
    ],
    platforms: ["android_twa", "api", "ios", "mini_program", "web"],
    unsupported: [],
  });
});

test("classifies Android wrapper separately while native Android is unsupported", (t) => {
  const repository = createRepository(t);
  const candidateCommit = repository.commit(["apps/android/MainActivity.kt"]);

  const scope = classifyCandidateChanges({
    repoPath: repository.repoPath,
    baseCommit: repository.baseCommit,
    candidateCommit,
  });

  assert.deepEqual(scope.platforms, []);
  assert.deepEqual(scope.unsupported, ["android_native"]);
});

test("plain Web Candidate changes never claim an Android TWA target", (t) => {
  const repository = createRepository(t);
  const candidateCommit = repository.commit(["apps/web/src/App.tsx"]);
  const scope = classifyCandidateChanges({
    repoPath: repository.repoPath, baseCommit: repository.baseCommit, candidateCommit,
  });

  assert.deepEqual(scope.platforms, ["web"]);
  assert.equal(scope.platforms.includes("android_twa"), false);
});

test("fails closed for invalid, missing, and non-ancestor Candidate commits", (t) => {
  const repository = createRepository(t);
  const candidateCommit = repository.commit(["apps/web/src/App.tsx"]);
  const independent = git(repository.repoPath, ["rev-parse", repository.baseCommit]);
  git(repository.repoPath, ["checkout", "--quiet", "-b", "side", repository.baseCommit]);
  fs.mkdirSync(path.join(repository.repoPath, "apps", "ios"), { recursive: true });
  fs.writeFileSync(path.join(repository.repoPath, "apps", "ios", "App.swift"), "side\n");
  git(repository.repoPath, ["add", "."]);
  git(repository.repoPath, ["commit", "--quiet", "-m", "side"]);
  const sideCommit = git(repository.repoPath, ["rev-parse", "HEAD"]);
  git(repository.repoPath, ["checkout", "--quiet", candidateCommit]);

  for (const input of [
    { baseCommit: "not-a-sha", candidateCommit },
    { baseCommit: repository.baseCommit, candidateCommit: "0".repeat(40) },
    { baseCommit: candidateCommit, candidateCommit: repository.baseCommit },
    { baseCommit: candidateCommit, candidateCommit: sideCommit },
  ]) {
    assert.throws(
      () => classifyCandidateChanges({ repoPath: repository.repoPath, ...input }),
      /candidate.*(invalid|missing|ancestor)|base.*ancestor/i,
    );
  }
  assert.equal(independent, repository.baseCommit);
});

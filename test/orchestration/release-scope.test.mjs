import assert from "node:assert/strict";
import test from "node:test";

import {
  activeVersionTasks,
  canonicalizeReleasePlatforms,
  resolveReleasePlatformEvidence,
} from "../../orchestration/release/release-scope.mjs";

const task = (id, status = "ready_for_release", platforms = []) => ({
  id, status, targetVersion: "v1.0.3", platforms,
});

test("pre-Manifest release scope excludes canceled tasks while a frozen Manifest remains immutable", () => {
  const tasks = [task("ready"), task("canceled", "canceled", ["web"]), task("other", "ready_for_release", ["web"] )];
  tasks[2].targetVersion = "v1.0.4";

  assert.deepEqual(
    activeVersionTasks({ tasks, versionName: "v1.0.3", manifest: null }).map(({ id }) => id),
    ["ready"],
  );
  assert.deepEqual(
    activeVersionTasks({ tasks, versionName: "v1.0.3", manifest: { taskIds: ["canceled", "ready"] } }).map(({ id }) => id),
    ["canceled", "ready"],
  );
});

test("release aliases normalize deterministically and Web/TWA Android does not invent a native target", () => {
  assert.deepEqual(
    canonicalizeReleasePlatforms(["服务端", "WEB", "ios", "小程序", "android", "custom"], {
      androidDelivery: "web_twa",
      nativeAndroidChanged: false,
    }),
    ["api", "web", "ios", "mini_program", "custom"],
  );
  assert.deepEqual(canonicalizeReleasePlatforms(["android"]), ["android"]);
});

test("explicit snapshot platforms win over job evidence", () => {
  assert.deepEqual(resolveReleasePlatformEvidence({
    task: task("task-1", "ready_for_release", ["服务端", "ios"]),
    aggregate: { version: 12 },
    developJobs: [{ id: "dev", status: "completed", result: { platforms: ["web"] } }],
  }), {
    taskId: "task-1", platforms: ["api", "ios"], source: "clickup_snapshot",
    evidenceId: null, commitSha: null, aggregateVersion: 12, androidDelivery: null,
  });
});

test("empty snapshots fall through current develop, analysis, then exact staging evidence", () => {
  const base = { task: task("task-1"), aggregate: { version: 12 } };
  assert.equal(resolveReleasePlatformEvidence({
    ...base,
    developJobs: [{ id: "dev", status: "completed", result: { platforms: ["web"], aggregateVersion: 12, commitSha: "abc" } }],
  }).source, "develop_job");
  assert.equal(resolveReleasePlatformEvidence({
    ...base,
    analyzeJobs: [{ id: "analysis", status: "completed", result: { summary: { platforms: ["ios"] }, aggregateVersion: 12 } }],
  }).source, "analyze_job");
  assert.equal(resolveReleasePlatformEvidence({
    ...base,
    acceptedCommitSha: "abc",
    stageJobs: [{ id: "stage", status: "completed", payload: { taskId: "task-1", commitSha: "abc", aggregateVersion: 12, platforms: ["小程序"] } }],
  }).source, "staging_job");
});

test("failed, stale, wrong-task and wrong-commit job evidence is rejected", () => {
  const result = resolveReleasePlatformEvidence({
    task: task("task-1"), aggregate: { version: 12 }, acceptedCommitSha: "accepted",
    developJobs: [
      { id: "failed", status: "failed", result: { platforms: ["web"], aggregateVersion: 12 } },
      { id: "stale", status: "completed", result: { platforms: ["ios"], aggregateVersion: 11 } },
    ],
    analyzeJobs: [{ id: "wrong-task", status: "completed", payload: { taskId: "task-2" }, result: { summary: { platforms: ["api"] }, aggregateVersion: 12 } }],
    stageJobs: [{ id: "wrong-commit", status: "completed", payload: { taskId: "task-1", commitSha: "other", aggregateVersion: 12, platforms: ["mini_program"] } }],
  });
  assert.deepEqual(result, {
    taskId: "task-1", platforms: [], source: "missing", evidenceId: null,
    commitSha: null, aggregateVersion: 12, androidDelivery: null,
  });
});


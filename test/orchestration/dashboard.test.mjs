import assert from "node:assert/strict";
import { test } from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { seedDashboardFixture } from "../helpers/dashboard-fixture.mjs";
import {
  buildDashboard,
  buildTaskDetail,
  buildVersionDetail,
} from "../../orchestration/dashboard/queries.mjs";

test("buildDashboard aggregates releasable versions, pipeline, versions and activity", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const payload = await buildDashboard(harness.db, {
    versionListUrl: "https://app.clickup.com/space-1/v/l/version-list",
  });

  assert.equal(payload.releasableVersions.length, 2);
  assert.equal(payload.releasableVersions[0].name, "1.0.1");
  assert.equal(payload.releasableVersions[0].taskCount, 1);
  assert.equal(payload.releasableVersions[0].readyCount, 1);
  assert.equal(payload.releasableVersions[0].releaseFailed, false);
  assert.equal(
    payload.releasableVersions[0].url,
    "https://app.clickup.com/space-1/v/l/version-list",
  );
  const failedVersion = payload.releasableVersions.find(
    (version) => version.name === "1.0.4",
  );
  assert.equal(failedVersion.releaseFailed, true);

  for (const state of [
    "inbox",
    "analyzing",
    "waiting_info",
    "ready_for_development",
    "developing",
    "ready_for_test",
    "testing",
    "ready_for_acceptance",
    "accepting",
    "ready_for_release",
    "published",
    "canceled",
  ]) {
    assert.equal(typeof payload.pipeline[state], "number");
  }
  assert.equal(payload.pipeline.ready_for_release, 3);
  assert.equal(payload.pipeline.waiting_info, 1);
  assert.equal(payload.pipeline.inbox, 0);

  assert.equal(payload.versions.length, 4);
  const released = payload.versions.find((version) => version.name === "1.0.1");
  assert.equal(released.releasable, true);
  assert.equal(released.releaseFailed, false);
  assert.equal(released.taskCount, 1);
  assert.equal(released.readyCount, 1);
  const active = payload.versions.find((version) => version.name === "1.0.2");
  assert.equal(active.releasable, false);
  const blocked = payload.versions.find((version) => version.name === "1.0.3");
  assert.equal(blocked.releasable, false);
  const failed = payload.versions.find((version) => version.name === "1.0.4");
  assert.equal(failed.releasable, true);
  assert.equal(failed.releaseFailed, true);

  assert.equal(payload.activity.length, 3);
  assert.equal(payload.activity[0].eventType, "version.release_prepared");
  assert.equal(payload.activity[0].summary, "版本 1.0.1 待发布");
  const activated = payload.activity.find(
    (item) => item.eventType === "version.activated",
  );
  assert.equal(activated.summary, "版本 1.0.1 进入进行中");
  const develop = payload.activity.find(
    (item) => item.eventType === "task.development_completed",
  );
  assert.equal(
    develop.summary,
    "任务 任务一 开发完成，PR：https://github.com/example/pr/1",
  );
});

test("buildTaskDetail aggregates analysis, development and acceptance results", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const detail = await buildTaskDetail(harness.db, "task-1");
  assert.equal(detail.name, "任务一");
  assert.equal(detail.targetVersion, "1.0.1");
  assert.equal(detail.status, "ready_for_release");
  assert.equal(detail.summary, "实现登录页");
  assert.deepEqual(detail.acceptanceCriteria, ["登录按钮可用"]);
  assert.equal(detail.changeSummary, "完成登录页");
  assert.equal(detail.prUrl, "https://github.com/example/pr/1");
  assert.equal(detail.acceptanceResult, "accepted");
  assert.equal(detail.timeline.length, 1);

  const missing = await buildTaskDetail(harness.db, "task-missing");
  assert.equal(missing, null);
});

test("buildVersionDetail returns the task list and manifest", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const detail = await buildVersionDetail(harness.db, "version-1");
  assert.equal(detail.name, "1.0.1");
  assert.equal(detail.status, "active");
  assert.equal(detail.blocked, false);
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.tasks[0].id, "task-1");
  assert.equal(detail.tasks[0].ready, true);
  assert.deepEqual(detail.manifest.taskIds, ["task-1"]);

  const missing = await buildVersionDetail(harness.db, "version-missing");
  assert.equal(missing, null);
});

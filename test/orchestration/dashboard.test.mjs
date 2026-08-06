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

test("activity correlates the development PR by command id even when the job completes later", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  await harness.db
    .prepare("UPDATE runner_jobs SET completed_at = ? WHERE id = 'task-1-develop-1'")
    .bind("2026-08-06T09:00:00.000Z")
    .run();

  const payload = await buildDashboard(harness.db);
  const develop = payload.activity.find(
    (item) => item.eventType === "task.development_completed",
  );
  assert.equal(
    develop.summary,
    "任务 任务一 开发完成，PR：https://github.com/example/pr/1",
  );
});

test("terminal, blocked and empty versions are never releasable", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  await harness.db
    .prepare("UPDATE orchestration_aggregates SET state = 'published' WHERE aggregate_type = 'version' AND aggregate_id = 'version-1'")
    .run();
  let payload = await buildDashboard(harness.db);
  assert.equal(payload.versions.find((v) => v.name === "1.0.1").releasable, false);
  assert.deepEqual(payload.releasableVersions.map((v) => v.name), ["1.0.4"]);
  const blockedCard = payload.versions.find((v) => v.name === "1.0.3");
  assert.equal(blockedCard.hasOpenBlockers, true);
  assert.equal(blockedCard.notReadyCount, 0);
  const failedCard = payload.versions.find((v) => v.name === "1.0.4");
  assert.equal(failedCard.hasOpenBlockers, false);
  assert.equal(failedCard.notReadyCount, 0);

  await harness.db
    .prepare("UPDATE orchestration_aggregates SET state = 'active' WHERE aggregate_type = 'version' AND aggregate_id = 'version-1'")
    .run();
  const blockedSnapshot = JSON.stringify({
    id: "version-1",
    listId: "list-version",
    name: "1.0.1",
    status: "active",
    blocked: true,
    updatedAt: "2026-08-06T08:00:00.000Z",
    fieldsHash: "h3",
  });
  await harness.db
    .prepare("UPDATE clickup_snapshots SET snapshot = ? WHERE object_type = 'version' AND object_id = 'version-1'")
    .bind(blockedSnapshot)
    .run();
  payload = await buildDashboard(harness.db);
  assert.equal(payload.versions.find((v) => v.name === "1.0.1").releasable, false);

  await harness.db
    .prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('version', 'version-empty', 'list-version', 'active', ?, 'h9', ?)
    `)
    .bind(JSON.stringify({
      id: "version-empty",
      listId: "list-version",
      name: "9.9.9",
      status: "active",
      blocked: false,
      updatedAt: "2026-08-06T08:00:00.000Z",
      fieldsHash: "h9",
    }), "2026-08-06T08:00:00.000Z")
    .run();
  await harness.db
    .prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('version', 'version-empty', 1, 'active', NULL, ?)
    `)
    .bind("2026-08-06T08:00:00.000Z")
    .run();
  payload = await buildDashboard(harness.db);
  const empty = payload.versions.find((v) => v.name === "9.9.9");
  assert.equal(empty.taskCount, 0);
  assert.equal(empty.releasable, false);
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

test("buildVersionDetail keeps manifest tasks even when the target version diverges", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  await harness.db
    .prepare("UPDATE clickup_snapshots SET snapshot = ? WHERE object_type = 'task' AND object_id = 'task-1'")
    .bind(JSON.stringify({
      id: "task-1",
      listId: "list-task",
      name: "任务一",
      status: "ready_for_release",
      targetVersion: "1.0.9",
      assignee: "狗哥",
      updatedAt: "2026-08-06T08:00:00.000Z",
      fieldsHash: "h1",
    }))
    .run();

  const detail = await buildVersionDetail(harness.db, "version-1");
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.tasks[0].id, "task-1");
});

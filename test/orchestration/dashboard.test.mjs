import assert from "node:assert/strict";
import { test } from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { DASHBOARD_NOW, seedDashboardFixture } from "../helpers/dashboard-fixture.mjs";
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
  assert.equal(payload.activity[0].eventType, "version.release_started");
  assert.equal(payload.activity[0].summary, "版本 1.0.1 发布中");
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

test("version detail returns safe readiness gaps and per-target release progress", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  await harness.db.prepare("UPDATE release_manifests SET manifest = ? WHERE version_id = 'version-1'").bind(JSON.stringify({
    versionId: "version-1", taskIds: ["task-1"], candidateCommit: "candidate-1", checksum: "abc",
    productionTargetPlan: {
      schemaVersion: 1,
      taskPlatforms: [{ taskId: "task-1", platforms: ["web", "ios"] }],
      platforms: { web: true, api: false, ios: true },
      iosApps: [{ id: "global", name: "海外版", appStoreAppId: "123", bundleId: "online.example.app", marketingVersion: "1.0.1", reviewConfigurationRef: "/private/review.json" }],
    },
  })).run();
  await harness.db.prepare(`INSERT INTO production_release_targets (
    version_id,candidate_commit,manifest_checksum,platform,app_id,attempt,stage,status,
    app_store_app_id,bundle_id,marketing_version,build_number,review_status,live_status,
    started_at,created_at,updated_at,sanitized_error_summary
  ) VALUES ('version-1','candidate-1','abc','ios','global',1,'review_wait','failed',
    '123','online.example.app','1.0.1','42','rejected','not_live',
    '${DASHBOARD_NOW}','${DASHBOARD_NOW}','${DASHBOARD_NOW}','review rejected')`).run();

  const detail = await buildVersionDetail(harness.db, "version-1");
  assert.deepEqual(detail.releaseReadiness, { ready: true, gaps: [] });
  assert.deepEqual(detail.releaseTargets, [{
    platform: "web", appId: null, label: "WEB", stage: "pending", status: "pending",
    attempt: 0, updatedAt: DASHBOARD_NOW, error: null, reviewStatus: null,
    liveStatus: null, buildNumber: null, reconciliationStatus: null, readbackStatus: null,
  }, {
    platform: "ios", appId: "global", label: "海外版", stage: "review_wait", status: "failed",
    appStoreAppId: "123", scheme: undefined, bundleId: "online.example.app", marketingVersion: "1.0.1",
    attempt: 1, updatedAt: DASHBOARD_NOW, error: "review rejected", reviewStatus: "rejected",
    liveStatus: "not_live", buildNumber: "42", reconciliationStatus: "not_required", readbackStatus: null,
  }]);
  assert.equal(JSON.stringify(detail).includes("reviewConfigurationRef"), false);
  assert.equal(JSON.stringify(detail).includes("/private/review.json"), false);
});

test("first-release iOS target preview derives the exact marketing version", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  await harness.db.prepare("DELETE FROM release_manifests WHERE version_id = 'version-1'").run();
  const row = await harness.db.prepare("SELECT snapshot FROM clickup_snapshots WHERE object_type = 'task' AND object_id = 'task-1'").first();
  const task = JSON.parse(row.snapshot);
  task.platforms = ["ios"];
  await harness.db.prepare("UPDATE clickup_snapshots SET snapshot = ? WHERE object_type = 'task' AND object_id = 'task-1'").bind(JSON.stringify(task)).run();
  const detail = await buildVersionDetail(harness.db, "version-1", { iosApps: [{
    id: "global", name: "海外版", enabled: true, appStoreAppId: "123", scheme: "Global",
    bundleId: "online.example.app",
  }] });
  assert.equal(detail.releaseTargets[0].marketingVersion, "1.0.1");
  assert.equal(JSON.stringify(detail).includes("undefined"), false);
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

test("activity shows acceptance failure reasons", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  await harness.db
    .prepare(`
      INSERT INTO orchestration_events (id, sequence, aggregate_type, aggregate_id, aggregate_version, type, command_id, actor_id, occurred_at, data, previous_hash, hash)
      VALUES ('evt-4', 4, 'task', 'task-1', 5, 'task.acceptance_failed', 'acceptance-task-1-accept-2', 'runner-acceptor', ?, '{}', 'h-e3', 'h-e4')
    `)
    .bind("2026-08-06T09:00:00.000Z")
    .run();
  await harness.db
    .prepare(`
      INSERT INTO runner_jobs (id, command_id, job_type, payload, payload_hash, status, result, created_at, completed_at)
      VALUES ('task-1-accept-2', 'acceptance-task-1-accept-2', 'accept', ?, 'p4', 'completed', ?, ?, ?)
    `)
    .bind(
      JSON.stringify({ taskId: "task-1" }),
      JSON.stringify({
        status: "completed",
        result: "rejected",
        findings: [
          { severity: "high", description: "按钮无法点击" },
          { severity: "medium", description: "旧版本兼容性未验证" },
        ],
      }),
      "2026-08-06T09:00:00.000Z",
      "2026-08-06T09:00:00.000Z",
    )
    .run();

  const payload = await buildDashboard(harness.db);
  const failed = payload.activity.find(
    (item) => item.eventType === "task.acceptance_failed",
  );
  assert.ok(failed);
  assert.match(failed.summary, /验收失败/);
  assert.match(failed.summary, /按钮无法点击/);
  assert.match(failed.summary, /旧版本兼容性未验证/);
});

test("terminal, blocked and empty versions are never releasable", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  await harness.db
    .prepare("UPDATE orchestration_aggregates SET state = 'published' WHERE aggregate_type = 'version' AND aggregate_id = 'version-1'")
    .run();
  let payload = await buildDashboard(harness.db);
  assert.equal(payload.versions.some((v) => v.name === "1.0.1"), false);
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

test("dashboard card and detail exclude canceled tasks before a Manifest is frozen", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  await harness.db.prepare("DELETE FROM release_manifests WHERE version_id = 'version-1'").run();
  await harness.db.prepare(`INSERT INTO clickup_snapshots
    (object_type,object_id,list_id,status,snapshot,fields_hash,read_at)
    VALUES ('task','task-canceled','list-task','canceled',?,'cancel-hash',?)`)
    .bind(JSON.stringify({ id: "task-canceled", name: "取消任务", status: "canceled", targetVersion: "1.0.1", platforms: ["web"] }), DASHBOARD_NOW).run();
  await harness.db.prepare(`INSERT INTO orchestration_aggregates
    (aggregate_type,aggregate_id,aggregate_version,state,snapshot,updated_at)
    VALUES ('task','task-canceled',3,'ready_for_development',NULL,?)`)
    .bind(DASHBOARD_NOW).run();

  const dashboard = await buildDashboard(harness.db);
  assert.equal(dashboard.pipeline.canceled, 1);
  assert.equal(dashboard.pipeline.ready_for_development, 0);
  const card = dashboard.versions.find((version) => version.id === "version-1");
  assert.equal(card.taskCount, 1);
  assert.equal(card.readyCount, 1);
  const detail = await buildVersionDetail(harness.db, "version-1");
  assert.deepEqual(detail.tasks.map(({ id }) => id), ["task-1"]);
});

test("version detail recovers canonical platforms from structured jobs and reports mini-program", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  await harness.db.prepare("DELETE FROM release_manifests WHERE version_id = 'version-1'").run();
  const row = await harness.db.prepare("SELECT snapshot FROM clickup_snapshots WHERE object_id = 'task-1'").first();
  const snapshot = JSON.parse(row.snapshot);
  snapshot.platforms = [];
  await harness.db.prepare("UPDATE clickup_snapshots SET snapshot = ? WHERE object_id = 'task-1'").bind(JSON.stringify(snapshot)).run();
  await harness.db.prepare("UPDATE runner_jobs SET result = ? WHERE id = 'task-1-develop-1'")
    .bind(JSON.stringify({ status: "completed", platforms: ["服务端", "小程序"], changeSummary: "完成登录页" })).run();

  const detail = await buildVersionDetail(harness.db, "version-1");
  assert.deepEqual(detail.taskPlatforms, [{ taskId: "task-1", platforms: ["api", "mini_program"], source: "develop_job" }]);
  assert.ok(detail.releaseReadiness.gaps.some((gap) => gap.includes("mini_program")));
  assert.equal(detail.releaseReadiness.gaps.some((gap) => gap.includes("任务缺少影响平台")), false);
});

test("version detail reports internal workflow state drift behind a ready ClickUp snapshot", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  await harness.db.prepare(
    "UPDATE orchestration_aggregates SET state='acceptance_rejected' WHERE aggregate_type='task' AND aggregate_id='task-1'",
  ).run();

  const detail = await buildVersionDetail(harness.db, "version-1");
  assert.equal(detail.tasks.find(({ id }) => id === "task-1").ready, false);
  assert.ok(detail.releaseReadiness.gaps.some((gap) => (
    gap.includes("内部流程尚未就绪") && gap.includes("task-1(acceptance_rejected)")
  )));
});

test("version detail marks the release blocked when a scoped task has an open blocker", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  await harness.db.prepare(`INSERT INTO blockers
    (id,object_type,object_id,type,reason,status,created_at)
    VALUES ('task-blocker','task','task-1','rework_budget','unfinished','open',?)`)
    .bind(DASHBOARD_NOW).run();

  const detail = await buildVersionDetail(harness.db, "version-1");
  assert.equal(detail.blocked, true);
});

test("dashboard progress and pipeline use internal workflow readiness instead of a stale ready snapshot", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  await harness.db.prepare(
    "UPDATE orchestration_aggregates SET state='waiting_info' WHERE aggregate_type='task' AND aggregate_id='task-1'",
  ).run();

  const dashboard = await buildDashboard(harness.db);
  const version = dashboard.versions.find(({ id }) => id === "version-1");
  assert.equal(version.taskCount, 1);
  assert.equal(version.readyCount, 0);
  assert.equal(version.notReadyCount, 1);
  assert.equal(version.releasable, false);
  assert.equal(dashboard.pipeline.waiting_info, 2);
  assert.equal(dashboard.pipeline.ready_for_release, 2);
  const detail = await buildVersionDetail(harness.db, "version-1");
  assert.equal(detail.tasks.filter(({ ready }) => ready).length, version.readyCount);
});

test("version detail treats a ready snapshot as ready when no internal aggregate exists", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  await harness.db.prepare(
    "DELETE FROM orchestration_aggregates WHERE aggregate_type='task' AND aggregate_id='task-1'",
  ).run();

  const dashboard = await buildDashboard(harness.db);
  const version = dashboard.versions.find(({ id }) => id === "version-1");
  const detail = await buildVersionDetail(harness.db, "version-1");
  assert.equal(version.readyCount, 1);
  assert.equal(detail.tasks.find(({ id }) => id === "task-1").ready, true);
});

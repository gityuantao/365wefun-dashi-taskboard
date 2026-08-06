# 运营驾驶舱（MVP 第二阶段）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

日期：2026-08-06
状态：待用户批准后进入实施
项目：王之强（狗哥）／365生活口语
代码基础：`gityuantao/365wefun-dashi-taskboard` Fork
设计文档：`docs/superpowers/specs/2026-08-06-operations-dashboard-design.md`

**Goal:** 把侧边栏入口替换为运营驾驶舱，单页展示「版本发布（待你操作）／流水线总览／版本进度／实时活动」，并支持任务与版本详情抽屉；数据来自编排 D1，页面每 15 秒自动刷新。

**Architecture:** orchestrator 进程内新增只读 HTTP 聚合端点（它已持有 Miniflare D1 连接），server 对 `/api/orchestration/dashboard*` 做本机反向代理；前端 React 新增 Dashboard 组件集，App 默认视图切换为 Dashboard，旧看板不再提供入口。数据聚合放在纯查询模块 `orchestration/dashboard/queries.mjs` 中，同时被 orchestrator HTTP 端点和 cloud worker 路由复用。

**Tech Stack:** Node.js 22.5+、原生 ESM、`node:test`、Miniflare/D1、React 19 + TypeScript、Vite、`node:http`。

## 全局约束

- 所有 dashboard 端点为只读，不修改 ClickUp、D1 或任何聚合状态。
- orchestrator HTTP 端点只绑定 `127.0.0.1`，端口默认 `47824`，可用 `ORCHESTRATION_DASHBOARD_PORT` 或 `runtime.dashboardPort` 覆盖；server 代理端口默认 `47824`，可用 `CODEX_TASKBOARD_ORCHESTRATION_PORT` 或 `createTaskboardServer({ orchestrationPort })` 覆盖。
- 前端不依赖现有 `/api/revisions` 轮询（本地模式已确认关闭），Dashboard 自己每 15 秒轮询。
- 任务详情数据源是 `runner_jobs.result`（执行摘要／验收标准／PR／验收结论）与 `orchestration_events`（时间线），不是 ClickUp 自定义字段。
- 实时活动主数据源是 `orchestration_events`，`runner_jobs` 只补充 PR／验收结论。
- 「可发布」判定与 `checkVersionGate` 对齐：版本内全部任务 `ready_for_release`、无 open task blocker（`blockers` 表）、版本未被 `发布阻塞` 字段阻塞、版本状态不是 `published/canceled/releasing`；`release_failed` 视为可重试，进入待办区并标记。
- server 代理 `/api/orchestration/dashboard*` 仅限本机 loopback 访问（与 `/api/local/*` 一致），避免局域网读取驾驶舱数据。
- 旧看板代码文件保留，但不渲染、不提供入口。

## 文件结构

| 文件 | 职责 |
|------|------|
| `orchestration/dashboard/queries.mjs` | 纯 D1 只读聚合：`buildDashboard`、`buildTaskDetail`、`buildVersionDetail` |
| `orchestration/dashboard/http-server.mjs` | orchestrator 进程内只读 HTTP 端点 |
| `cloud/src/dashboard-routes.mjs` | cloud worker 里的 dashboard 路由（诊断开关控制） |
| `cloud/src/index.mjs` | 挂载 dashboard 路由（修改） |
| `scripts/orchestrator.mjs` | 启动 dashboard HTTP 服务（修改） |
| `server/app.mjs` | 新增 `/api/orchestration/dashboard*` 本机代理（修改） |
| `web/src/types.ts` | dashboard 类型定义（修改） |
| `web/src/api.ts` | dashboard API 客户端（修改） |
| `web/src/components/dashboard/Dashboard.tsx` | 驾驶舱容器 + 15 秒轮询 |
| `web/src/components/dashboard/ReleaseActions.tsx` | 版本发布待办区 |
| `web/src/components/dashboard/PipelineOverview.tsx` | 流水线总览 |
| `web/src/components/dashboard/VersionProgress.tsx` | 版本进度列表 |
| `web/src/components/dashboard/ActivityFeed.tsx` | 实时活动 |
| `web/src/components/dashboard/DetailDrawer.tsx` | 右侧详情抽屉 |
| `web/src/components/dashboard/dashboard.css` | 驾驶舱样式 |
| `web/src/App.tsx` | 默认视图切换为 Dashboard（修改） |
| `test/helpers/dashboard-fixture.mjs` | 共享测试种子数据 |
| `test/orchestration/dashboard.test.mjs` | 查询模块测试 |
| `test/orchestration/dashboard-routes.test.mjs` | cloud worker 路由测试 |
| `test/orchestration/dashboard-http.test.mjs` | orchestrator HTTP 端点测试 |
| `test/server-dashboard-proxy.test.mjs` | server 代理测试 |
| `test/dashboard-api.test.mjs` | 前端 API／类型源码断言 |
| `test/dashboard-components.test.mjs` | Dashboard 组件源码断言 |
| `test/dashboard-view.test.mjs` | App 默认视图源码断言 |
| `test/board-views.test.mjs` | 更新旧断言（修改） |

---

## Task 1: Dashboard 查询模块

**Files:**
- Create: `orchestration/dashboard/queries.mjs`
- Create: `test/helpers/dashboard-fixture.mjs`
- Test: `test/orchestration/dashboard.test.mjs`

- [ ] **Step 1: 写测试种子与失败测试**

Create `test/helpers/dashboard-fixture.mjs`:

```js
export const DASHBOARD_NOW = "2026-08-06T08:00:00.000Z";

export async function seedDashboardFixture(db) {
  const statements = [
    db.prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('task', 'task-1', 'list-task', 'ready_for_release', ?, 'h1', ?)
    `).bind(JSON.stringify({
      id: "task-1",
      listId: "list-task",
      name: "任务一",
      status: "ready_for_release",
      targetVersion: "1.0.1",
      assignee: "狗哥",
      updatedAt: DASHBOARD_NOW,
      fieldsHash: "h1",
    }), DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('task', 'task-2', 'list-task', 'waiting_info', ?, 'h2', ?)
    `).bind(JSON.stringify({
      id: "task-2",
      listId: "list-task",
      name: "任务二",
      status: "waiting_info",
      targetVersion: "1.0.2",
      assignee: null,
      updatedAt: DASHBOARD_NOW,
      fieldsHash: "h2",
    }), DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('task', 'task-3', 'list-task', 'ready_for_release', ?, 'h5', ?)
    `).bind(JSON.stringify({
      id: "task-3",
      listId: "list-task",
      name: "任务三",
      status: "ready_for_release",
      targetVersion: "1.0.3",
      assignee: null,
      updatedAt: DASHBOARD_NOW,
      fieldsHash: "h5",
    }), DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('task', 'task-4', 'list-task', 'ready_for_release', ?, 'h6', ?)
    `).bind(JSON.stringify({
      id: "task-4",
      listId: "list-task",
      name: "任务四",
      status: "ready_for_release",
      targetVersion: "1.0.4",
      assignee: null,
      updatedAt: DASHBOARD_NOW,
      fieldsHash: "h6",
    }), DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('version', 'version-1', 'list-version', 'active', ?, 'h3', ?)
    `).bind(JSON.stringify({
      id: "version-1",
      listId: "list-version",
      name: "1.0.1",
      status: "active",
      blocked: false,
      updatedAt: DASHBOARD_NOW,
      fieldsHash: "h3",
    }), DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('version', 'version-2', 'list-version', 'active', ?, 'h4', ?)
    `).bind(JSON.stringify({
      id: "version-2",
      listId: "list-version",
      name: "1.0.2",
      status: "active",
      blocked: false,
      updatedAt: DASHBOARD_NOW,
      fieldsHash: "h4",
    }), DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('version', 'version-3', 'list-version', 'active', ?, 'h7', ?)
    `).bind(JSON.stringify({
      id: "version-3",
      listId: "list-version",
      name: "1.0.3",
      status: "active",
      blocked: false,
      updatedAt: DASHBOARD_NOW,
      fieldsHash: "h7",
    }), DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('version', 'version-4', 'list-version', 'release_failed', ?, 'h8', ?)
    `).bind(JSON.stringify({
      id: "version-4",
      listId: "list-version",
      name: "1.0.4",
      status: "release_failed",
      blocked: false,
      updatedAt: DASHBOARD_NOW,
      fieldsHash: "h8",
    }), DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('task', 'task-1', 4, 'ready_for_release', NULL, ?)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('task', 'task-2', 2, 'waiting_info', NULL, ?)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('task', 'task-3', 4, 'ready_for_release', NULL, ?)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('task', 'task-4', 4, 'ready_for_release', NULL, ?)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('version', 'version-1', 1, 'active', NULL, ?)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('version', 'version-2', 1, 'active', NULL, ?)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('version', 'version-3', 1, 'active', NULL, ?)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('version', 'version-4', 2, 'release_failed', NULL, ?)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO blockers (id, object_type, object_id, type, reason, status, created_at, resolved_at)
      VALUES ('blocker-1', 'task', 'task-3', 'blocked', '等待外部依赖', 'open', ?, NULL)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_events (id, sequence, aggregate_type, aggregate_id, aggregate_version, type, command_id, actor_id, occurred_at, data, previous_hash, hash)
      VALUES ('evt-1', 1, 'version', 'version-1', 1, 'version.activated', 'cmd-seed-1', 'system', ?, '{}', NULL, 'h-e1')
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_events (id, sequence, aggregate_type, aggregate_id, aggregate_version, type, command_id, actor_id, occurred_at, data, previous_hash, hash)
      VALUES ('evt-2', 2, 'task', 'task-1', 3, 'task.development_completed', 'development-task-1-develop-1', 'runner-developer', ?, '{}', 'h-e1', 'h-e2')
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_events (id, sequence, aggregate_type, aggregate_id, aggregate_version, type, command_id, actor_id, occurred_at, data, previous_hash, hash)
      VALUES ('evt-3', 3, 'version', 'version-1', 2, 'version.release_prepared', 'cmd-seed-3', 'system-aggregator', ?, '{}', 'h-e2', 'h-e3')
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO runner_jobs (id, command_id, job_type, payload, payload_hash, status, result, created_at, completed_at)
      VALUES ('task-1-analyze-1', 'auto-analyze-task-1', 'analyze', ?, 'p1', 'completed', ?, ?, ?)
    `).bind(
      JSON.stringify({ taskId: "task-1" }),
      JSON.stringify({
        status: "completed",
        summary: {
          scope: "实现登录页",
          acceptance_criteria: [{ criterion: "登录按钮可用" }],
        },
      }),
      DASHBOARD_NOW,
      DASHBOARD_NOW,
    ),
    db.prepare(`
      INSERT INTO runner_jobs (id, command_id, job_type, payload, payload_hash, status, result, created_at, completed_at)
      VALUES ('task-1-develop-1', 'auto-develop-task-1', 'develop', ?, 'p2', 'completed', ?, ?, ?)
    `).bind(
      JSON.stringify({ taskId: "task-1" }),
      JSON.stringify({
        status: "completed",
        pr: { url: "https://github.com/example/pr/1" },
        changeSummary: "完成登录页",
      }),
      DASHBOARD_NOW,
      DASHBOARD_NOW,
    ),
    db.prepare(`
      INSERT INTO runner_jobs (id, command_id, job_type, payload, payload_hash, status, result, created_at, completed_at)
      VALUES ('task-1-accept-1', 'auto-accept-task-1', 'accept', ?, 'p3', 'completed', ?, ?, ?)
    `).bind(
      JSON.stringify({ taskId: "task-1" }),
      JSON.stringify({ status: "completed", result: "accepted" }),
      DASHBOARD_NOW,
      DASHBOARD_NOW,
    ),
    db.prepare(`
      INSERT INTO release_manifests (version_id, manifest, created_at) VALUES ('version-1', ?, ?)
    `).bind(
      JSON.stringify({
        versionId: "version-1",
        taskIds: ["task-1"],
        createdAt: DASHBOARD_NOW,
        checksum: "abc",
      }),
      DASHBOARD_NOW,
    ),
  ];
  await db.batch(statements);
}
```

Create `test/orchestration/dashboard.test.mjs`:

```js
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
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `node --test test/orchestration/dashboard.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`（`queries.mjs` 尚不存在）。

- [ ] **Step 3: 实现查询模块**

Create `orchestration/dashboard/queries.mjs`:

```js
import { TASK_STATES } from "../domain/task-state.mjs";
import { compareVersions } from "../release/version-utils.mjs";

const ACTIVITY_LABELS = {
  "task.analysis_started": "开始分析",
  "task.analysis_completed": "分析完成",
  "task.analysis_needs_human": "需要补充信息",
  "task.analysis_restarted": "重新分析",
  "task.development_started": "开始开发",
  "task.development_completed": "开发完成",
  "task.development_failed": "开发失败，退回待开发",
  "task.test_started": "开始测试",
  "task.test_passed": "测试通过",
  "task.test_failed": "测试失败，退回待开发",
  "task.acceptance_started": "开始验收",
  "task.acceptance_passed": "验收通过",
  "task.acceptance_failed": "验收失败，退回待开发",
  "task.published": "已发布",
  "task.canceled": "已取消",
  "version.activated": "进入进行中",
  "version.release_prepared": "待发布",
  "version.release_started": "发布中",
  "version.published": "已发布",
  "version.release_failed": "发布失败",
  "version.release_retried": "重试发布",
  "version.returned_to_active": "退回进行中",
  "version.canceled": "已取消",
};

function parseSnapshot(row) {
  return row.snapshot === null ? null : JSON.parse(row.snapshot);
}

async function loadTasks(db) {
  const rows = (await db.prepare(`
    SELECT s.snapshot, s.status AS snapshot_status, a.state AS aggregate_state
    FROM clickup_snapshots s
    LEFT JOIN orchestration_aggregates a
      ON a.aggregate_type = 'task' AND a.aggregate_id = s.object_id
    WHERE s.object_type = 'task'
  `).all()).results;
  return rows
    .map((row) => ({
      ...parseSnapshot(row),
      status: row.aggregate_state ?? row.snapshot_status,
    }))
    .filter((task) => task?.id);
}

async function loadVersions(db) {
  const rows = (await db.prepare(`
    SELECT s.snapshot, s.status AS snapshot_status, a.state AS aggregate_state
    FROM clickup_snapshots s
    LEFT JOIN orchestration_aggregates a
      ON a.aggregate_type = 'version' AND a.aggregate_id = s.object_id
    WHERE s.object_type = 'version'
  `).all()).results;
  return rows
    .map((row) => ({
      ...parseSnapshot(row),
      status: row.aggregate_state ?? row.snapshot_status,
    }))
    .filter((version) => version?.id);
}

async function loadOpenTaskBlockers(db) {
  const rows = (await db
    .prepare(`
      SELECT object_id FROM blockers
      WHERE status = 'open' AND object_type = 'task'
    `)
    .all()).results;
  return new Set(rows.map((row) => row.object_id));
}

async function latestJob(db, taskId, jobType) {
  const row = await db
    .prepare(`
      SELECT result FROM runner_jobs
      WHERE id LIKE ? AND job_type = ? AND status = 'completed'
      ORDER BY completed_at DESC, created_at DESC LIMIT 1
    `)
    .bind(`${taskId}-${jobType}-%`, jobType)
    .first();
  return row ? { result: JSON.parse(row.result) } : null;
}

function prUrlOf(result) {
  if (!result) return null;
  if (typeof result.pr === "string") return result.pr;
  return result.pr?.url ?? null;
}

async function loadActivity(db, limit, tasks, versions) {
  const events = (await db
    .prepare(`
      SELECT aggregate_type, aggregate_id, type, occurred_at, command_id
      FROM orchestration_events
      ORDER BY occurred_at DESC, sequence DESC
      LIMIT ?
    `)
    .bind(limit)
    .all()).results;
  if (events.length === 0) return [];

  const names = new Map([
    ...tasks.map((task) => [`task:${task.id}`, task.name ?? task.id]),
    ...versions.map((version) => [`version:${version.id}`, version.name ?? version.id]),
  ]);

  return Promise.all(events.map(async (event) => {
    const key = `${event.aggregate_type}:${event.aggregate_id}`;
    const name = names.get(key) ?? event.aggregate_id;
    const subject = event.aggregate_type === "version" ? `版本 ${name}` : `任务 ${name}`;
    const label = ACTIVITY_LABELS[event.type] ?? event.type;
    let summary = `${subject} ${label}`;
    if (
      event.type === "task.development_completed"
      && typeof event.command_id === "string"
      && event.command_id.startsWith("development-")
    ) {
      const jobId = event.command_id.slice("development-".length);
      const row = await db
        .prepare("SELECT result FROM runner_jobs WHERE id = ? AND status = 'completed'")
        .bind(jobId)
        .first();
      const result = row ? JSON.parse(row.result) : null;
      if (prUrlOf(result)) {
        summary = `${subject} 开发完成，PR：${prUrlOf(result)}`;
      }
    }
    return {
      time: event.occurred_at,
      objectType: event.aggregate_type,
      objectId: event.aggregate_id,
      eventType: event.type,
      summary,
    };
  }));
}

export async function buildDashboard(db, { versionListUrl } = {}) {
  const [tasks, versions, openTaskBlockers] = await Promise.all([
    loadTasks(db),
    loadVersions(db),
    loadOpenTaskBlockers(db),
  ]);
  const pipeline = Object.fromEntries(TASK_STATES.map((state) => [state, 0]));
  for (const task of tasks) {
    if (pipeline[task.status] !== undefined) pipeline[task.status] += 1;
  }

  const versionProgress = versions
    .map((version) => {
      const tasksInVersion = tasks.filter(
        (task) => task.targetVersion === (version.name ?? version.id),
      );
      const readyCount = tasksInVersion.filter(
        (task) => task.status === "ready_for_release",
      ).length;
      const allReady = tasksInVersion.length > 0
        && tasksInVersion.every((task) => task.status === "ready_for_release");
      const noOpenBlockers = tasksInVersion.every(
        (task) => !openTaskBlockers.has(task.id),
      );
      return {
        id: version.id,
        name: version.name ?? version.id,
        status: version.status ?? null,
        taskCount: tasksInVersion.length,
        readyCount,
        releasable: version.status !== "published"
          && version.status !== "canceled"
          && version.status !== "releasing"
          && version.blocked !== true
          && allReady
          && noOpenBlockers,
        releaseFailed: version.status === "release_failed",
      };
    })
    .sort((left, right) => compareVersions(left.name, right.name) || left.name.localeCompare(right.name));

  const releasableVersions = versionProgress
    .filter((version) => version.releasable)
    .map((version) => ({
      id: version.id,
      name: version.name,
      taskCount: version.taskCount,
      readyCount: version.readyCount,
      releaseFailed: version.releaseFailed,
      url: versionListUrl ?? `https://app.clickup.com/v/l/${version.id}`,
    }));

  const activity = await loadActivity(db, 20, tasks, versions);
  return { releasableVersions, pipeline, versions: versionProgress, activity };
}

async function loadTimeline(db, taskId) {
  const rows = (await db
    .prepare(`
      SELECT type, occurred_at, data FROM orchestration_events
      WHERE aggregate_type = 'task' AND aggregate_id = ?
      ORDER BY sequence DESC LIMIT 50
    `)
    .bind(taskId)
    .all()).results;
  return rows
    .map((row) => ({
      time: row.occurred_at,
      eventType: row.type,
      summary: ACTIVITY_LABELS[row.type] ?? row.type,
      data: row.data === null ? null : JSON.parse(row.data),
    }))
    .reverse();
}

export async function buildTaskDetail(db, taskId) {
  const [snapshotRow, aggregateRow] = await Promise.all([
    db
      .prepare(`
        SELECT snapshot, status FROM clickup_snapshots
        WHERE object_type = 'task' AND object_id = ?
      `)
      .bind(taskId)
      .first(),
    db
      .prepare(`
        SELECT state FROM orchestration_aggregates
        WHERE aggregate_type = 'task' AND aggregate_id = ?
      `)
      .bind(taskId)
      .first(),
  ]);
  if (!snapshotRow) return null;
  const snapshot = JSON.parse(snapshotRow.snapshot);
  const status = aggregateRow?.state ?? snapshotRow.status;

  const [analyzeJob, developJob, acceptJob, timeline] = await Promise.all([
    latestJob(db, taskId, "analyze"),
    latestJob(db, taskId, "develop"),
    latestJob(db, taskId, "accept"),
    loadTimeline(db, taskId),
  ]);
  const analysisSummary = analyzeJob?.result?.summary ?? null;

  return {
    id: taskId,
    name: snapshot.name ?? taskId,
    targetVersion: snapshot.targetVersion ?? null,
    status,
    assignee: snapshot.assignee ?? null,
    updatedAt: snapshot.updatedAt ?? null,
    summary: analysisSummary?.scope ?? null,
    acceptanceCriteria: (analysisSummary?.acceptance_criteria ?? []).map((criterion) => (
      typeof criterion === "string" ? criterion : criterion.criterion
    )),
    changeSummary: developJob?.result?.changeSummary ?? null,
    prUrl: prUrlOf(developJob?.result),
    acceptanceResult: acceptJob?.result?.result ?? null,
    timeline,
  };
}

export async function buildVersionDetail(db, versionId) {
  const [snapshotRow, aggregateRow, manifestRow, tasks] = await Promise.all([
    db
      .prepare(`
        SELECT snapshot, status FROM clickup_snapshots
        WHERE object_type = 'version' AND object_id = ?
      `)
      .bind(versionId)
      .first(),
    db
      .prepare(`
        SELECT state FROM orchestration_aggregates
        WHERE aggregate_type = 'version' AND aggregate_id = ?
      `)
      .bind(versionId)
      .first(),
    db
      .prepare("SELECT manifest FROM release_manifests WHERE version_id = ?")
      .bind(versionId)
      .first(),
    loadTasks(db),
  ]);
  if (!snapshotRow) return null;
  const snapshot = JSON.parse(snapshotRow.snapshot);
  const status = aggregateRow?.state ?? snapshotRow.status;
  const matchingTasks = tasks.filter(
    (task) => task.targetVersion === (snapshot.name ?? versionId),
  );
  const byTaskId = new Map(tasks.map((task) => [task.id, task]));
  const manifest = manifestRow ? JSON.parse(manifestRow.manifest) : null;
  const orderedTaskIds = manifest
    ? [...new Set([...manifest.taskIds, ...matchingTasks.map((task) => task.id)])]
    : matchingTasks.map((task) => task.id);
  const versionTasks = orderedTaskIds
    .map((taskId) => byTaskId.get(taskId))
    .filter(Boolean)
    .map((task) => ({
      id: task.id,
      name: task.name ?? task.id,
      status: task.status,
      ready: task.status === "ready_for_release",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    id: versionId,
    name: snapshot.name ?? versionId,
    status,
    blocked: snapshot.blocked === true,
    tasks: versionTasks,
    manifest,
  };
}
```

- [ ] **Step 4: 运行测试，验证通过**

Run: `node --test test/orchestration/dashboard.test.mjs`
Expected: PASS（5 个测试全部通过）。

- [ ] **Step 5: 提交**

```bash
git add orchestration/dashboard/queries.mjs test/helpers/dashboard-fixture.mjs test/orchestration/dashboard.test.mjs
git commit -m "feat: add orchestration dashboard read queries"
```

---

## Task 2: Cloud worker dashboard 路由

**Files:**
- Create: `cloud/src/dashboard-routes.mjs`
- Modify: `cloud/src/index.mjs`
- Test: `test/orchestration/dashboard-routes.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `test/orchestration/dashboard-routes.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { seedDashboardFixture } from "../helpers/dashboard-fixture.mjs";

test("dashboard routes are disabled by default", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const response = await harness.request("/api/orchestration/dashboard", {
    method: "GET",
    actorName: "owner",
  });
  assert.equal(response.response.status, 404);
  assert.equal(response.body.error.code, "ORCHESTRATION_DISABLED");
});

test("dashboard routes return aggregated payload when enabled", async (t) => {
  const harness = await createCloudWorkerHarness({
    bindings: {
      ORCHESTRATION_DIAGNOSTIC_ENABLED: "true",
      CLICKUP_CONFIG: JSON.stringify({
        spaceId: "space-1",
        lists: { version: { id: "version-list" } },
      }),
    },
  });
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const response = await harness.request("/api/orchestration/dashboard", {
    method: "GET",
    actorName: "owner",
  });
  assert.equal(response.response.status, 200);
  assert.equal(response.body.versions[0].name, "1.0.1");
  assert.equal(
    response.body.releasableVersions[0].url,
    "https://app.clickup.com/space-1/v/l/version-list",
  );
});

test("task detail route returns 404 for unknown tasks and 405 for POST", async (t) => {
  const harness = await createCloudWorkerHarness({
    bindings: { ORCHESTRATION_DIAGNOSTIC_ENABLED: "true" },
  });
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const missing = await harness.request("/api/orchestration/dashboard/tasks/missing", {
    method: "GET",
    actorName: "owner",
  });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, "NOT_FOUND");

  const post = await harness.request("/api/orchestration/dashboard", {
    method: "POST",
    actorName: "owner",
  });
  assert.equal(post.response.status, 405);
  assert.deepEqual(post.body.error.details.allowed, ["GET"]);
});

test("task detail and version detail routes return payloads and reject bad ids", async (t) => {
  const harness = await createCloudWorkerHarness({
    bindings: { ORCHESTRATION_DIAGNOSTIC_ENABLED: "true" },
  });
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const task = await harness.request("/api/orchestration/dashboard/tasks/task-1", {
    method: "GET",
    actorName: "owner",
  });
  assert.equal(task.response.status, 200);
  assert.equal(task.body.prUrl, "https://github.com/example/pr/1");

  const version = await harness.request("/api/orchestration/dashboard/versions/version-1", {
    method: "GET",
    actorName: "owner",
  });
  assert.equal(version.response.status, 200);
  assert.equal(version.body.tasks.length, 1);

  const missingVersion = await harness.request("/api/orchestration/dashboard/versions/missing", {
    method: "GET",
    actorName: "owner",
  });
  assert.equal(missingVersion.response.status, 404);
  assert.equal(missingVersion.body.error.code, "NOT_FOUND");

  const malformed = await harness.request("/api/orchestration/dashboard/tasks/%", {
    method: "GET",
    actorName: "owner",
  });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.error.code, "INVALID_PATH");
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `node --test test/orchestration/dashboard-routes.test.mjs`
Expected: FAIL（`/api/orchestration/dashboard` 目前落到 `NOT_FOUND`）。

- [ ] **Step 3: 实现 dashboard 路由模块**

Create `cloud/src/dashboard-routes.mjs`:

```js
import {
  buildDashboard,
  buildTaskDetail,
  buildVersionDetail,
} from "../../orchestration/dashboard/queries.mjs";

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function methodNotAllowed(allowed) {
  return json(405, {
    error: {
      code: "METHOD_NOT_ALLOWED",
      message: "Method not allowed",
      details: { allowed },
    },
  });
}

function versionListUrlFromConfig(configJson) {
  if (!configJson) return null;
  try {
    const config = JSON.parse(configJson);
    const listId = config.lists?.version?.id ?? config.lists?.versionSandbox?.id ?? "";
    if (!config.spaceId || !listId) return null;
    return `https://app.clickup.com/${encodeURIComponent(config.spaceId)}/v/l/${encodeURIComponent(listId)}`;
  } catch {
    return null;
  }
}

export async function routeDashboardRequest(request, env) {
  if (env.ORCHESTRATION_DIAGNOSTIC_ENABLED !== "true") {
    return json(404, {
      error: {
        code: "ORCHESTRATION_DISABLED",
        message: "Orchestration diagnostic API is disabled",
      },
    });
  }

  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === "/api/orchestration/dashboard") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return json(200, await buildDashboard(env.DB, {
      versionListUrl: versionListUrlFromConfig(env.CLICKUP_CONFIG),
    }));
  }

  const taskMatch = pathname.match(/^\/api\/orchestration\/dashboard\/tasks\/([^/]+)$/);
  if (taskMatch) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    let taskId;
    try {
      taskId = decodeURIComponent(taskMatch[1]);
    } catch {
      return json(400, {
        error: { code: "INVALID_PATH", message: "Task id contains invalid encoding" },
      });
    }
    const detail = await buildTaskDetail(env.DB, taskId);
    if (!detail) {
      return json(404, { error: { code: "NOT_FOUND", message: "Task not found" } });
    }
    return json(200, detail);
  }

  const versionMatch = pathname.match(/^\/api\/orchestration\/dashboard\/versions\/([^/]+)$/);
  if (versionMatch) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    let versionId;
    try {
      versionId = decodeURIComponent(versionMatch[1]);
    } catch {
      return json(400, {
        error: { code: "INVALID_PATH", message: "Version id contains invalid encoding" },
      });
    }
    const detail = await buildVersionDetail(env.DB, versionId);
    if (!detail) {
      return json(404, { error: { code: "NOT_FOUND", message: "Version not found" } });
    }
    return json(200, detail);
  }

  return json(404, { error: { code: "NOT_FOUND", message: "API route not found" } });
}
```

- [ ] **Step 4: 挂载到 cloud worker**

Modify `cloud/src/index.mjs`：

在文件顶部 import 区加入：

```js
import { routeDashboardRequest } from "./dashboard-routes.mjs";
```

在 `routeApi` 函数里、现有 `/api/orchestration/commands` 分支之前加入：

```js
  if (
    pathname === "/api/orchestration/dashboard"
    || pathname.startsWith("/api/orchestration/dashboard/")
  ) {
    return routeDashboardRequest(request, env);
  }
```

- [ ] **Step 5: 运行测试，验证通过**

Run: `node --test test/orchestration/dashboard-routes.test.mjs`
Expected: PASS（4 个测试全部通过）。

- [ ] **Step 6: 提交**

```bash
git add cloud/src/dashboard-routes.mjs cloud/src/index.mjs test/orchestration/dashboard-routes.test.mjs
git commit -m "feat: expose orchestration dashboard routes on the cloud worker"
```
---

## Task 3: Orchestrator 本地只读 HTTP 端点

**Files:**
- Create: `orchestration/dashboard/http-server.mjs`
- Modify: `scripts/orchestrator.mjs`
- Test: `test/orchestration/dashboard-http.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `test/orchestration/dashboard-http.test.mjs`:

```js
import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { seedDashboardFixture } from "../helpers/dashboard-fixture.mjs";
import { startDashboardServer } from "../../orchestration/dashboard/http-server.mjs";

function rawRequest(port, raw) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(raw));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error("raw request timed out"));
    });
  });
}

test("orchestrator dashboard server exposes read-only JSON endpoints", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const dashboard = await startDashboardServer({
    db: harness.db,
    port: 0,
    versionListUrl: "https://app.clickup.com/space-1/v/l/version-list",
  });
  t.after(() => dashboard.close());

  const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.releasableVersions.length, 2);
  assert.equal(
    payload.releasableVersions[0].url,
    "https://app.clickup.com/space-1/v/l/version-list",
  );

  const taskResponse = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/tasks/task-1`,
  );
  assert.equal(taskResponse.status, 200);
  const task = await taskResponse.json();
  assert.equal(task.prUrl, "https://github.com/example/pr/1");

  const versionResponse = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/version-1`,
  );
  assert.equal(versionResponse.status, 200);
  const version = await versionResponse.json();
  assert.equal(version.tasks.length, 1);

  const post = await fetch(`http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard`, {
    method: "POST",
  });
  assert.equal(post.status, 405);
  const postBody = await post.json();
  assert.deepEqual(postBody.error.details.allowed, ["GET"]);

  const missing = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/tasks/missing`,
  );
  assert.equal(missing.status, 404);

  const missingVersion = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/missing`,
  );
  assert.equal(missingVersion.status, 404);

  const malformed = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/tasks/%`,
  );
  assert.equal(malformed.status, 400);
  const malformedBody = await malformed.json();
  assert.equal(malformedBody.error.code, "INVALID_PATH");
});

test("invalid absolute-form request targets still receive a 500 response", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const dashboard = await startDashboardServer({ db: harness.db, port: 0 });
  t.after(() => dashboard.close());

  const raw = await rawRequest(
    dashboard.port,
    "GET http://[bad/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
  );
  assert.match(raw, /HTTP\/1\.1 500/);
  assert.match(raw, /INTERNAL_ERROR/);
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `node --test test/orchestration/dashboard-http.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`（`http-server.mjs` 尚不存在）。

- [ ] **Step 3: 实现 HTTP 服务模块**

Create `orchestration/dashboard/http-server.mjs`:

```js
import { createServer } from "node:http";

import { buildDashboard, buildTaskDetail, buildVersionDetail } from "./queries.mjs";

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function methodNotAllowed(response, allowed) {
  sendJson(response, 405, {
    error: {
      code: "METHOD_NOT_ALLOWED",
      message: "Method not allowed",
      details: { allowed },
    },
  });
}

export async function startDashboardServer({ db, port = 47824, versionListUrl = null }) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const { pathname } = url;
      if (pathname === "/api/orchestration/dashboard") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return sendJson(response, 200, await buildDashboard(db, { versionListUrl }));
      }

      const taskMatch = pathname.match(/^\/api\/orchestration\/dashboard\/tasks\/([^/]+)$/);
      if (taskMatch) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        let taskId;
        try {
          taskId = decodeURIComponent(taskMatch[1]);
        } catch {
          return sendJson(response, 400, {
            error: { code: "INVALID_PATH", message: "Task id contains invalid encoding" },
          });
        }
        const detail = await buildTaskDetail(db, taskId);
        if (!detail) {
          return sendJson(response, 404, {
            error: { code: "NOT_FOUND", message: "Task not found" },
          });
        }
        return sendJson(response, 200, detail);
      }

      const versionMatch = pathname.match(/^\/api\/orchestration\/dashboard\/versions\/([^/]+)$/);
      if (versionMatch) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        let versionId;
        try {
          versionId = decodeURIComponent(versionMatch[1]);
        } catch {
          return sendJson(response, 400, {
            error: { code: "INVALID_PATH", message: "Version id contains invalid encoding" },
          });
        }
        const detail = await buildVersionDetail(db, versionId);
        if (!detail) {
          return sendJson(response, 404, {
            error: { code: "NOT_FOUND", message: "Version not found" },
          });
        }
        return sendJson(response, 200, detail);
      }

      return sendJson(response, 404, {
        error: { code: "NOT_FOUND", message: "Route not found" },
      });
    } catch (error) {
      console.error(error);
      return sendJson(response, 500, {
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
```

- [ ] **Step 4: 接入 orchestrator 启动流程**

Modify `scripts/orchestrator.mjs`：

在 import 区加入：

```js
import { startDashboardServer } from "../orchestration/dashboard/http-server.mjs";
```

在 `const taskListKey = ...` 和 `const versionListKey = ...` 两行之后、`const handlers = {` 之前加入：

```js
const dashboardServer = await startDashboardServer({
  db,
  port: Number(runtime.dashboardPort ?? process.env.ORCHESTRATION_DASHBOARD_PORT ?? 47824),
  versionListUrl: `https://app.clickup.com/${encodeURIComponent(config.spaceId)}/v/l/${encodeURIComponent(config.lists[versionListKey].id)}`,
});
log(`dashboard listening on http://127.0.0.1:${dashboardServer.port}`);
```

- [ ] **Step 5: 运行测试，验证通过**

Run: `node --test test/orchestration/dashboard-http.test.mjs`
Expected: PASS（2 个测试通过）。

- [ ] **Step 6: 提交**

```bash
git add orchestration/dashboard/http-server.mjs scripts/orchestrator.mjs test/orchestration/dashboard-http.test.mjs
git commit -m "feat: serve read-only dashboard endpoint from the orchestrator"
```

---

## Task 4: Server 反向代理

**Files:**
- Modify: `server/app.mjs`
- Modify: `server/index.mjs`
- Test: `test/server-dashboard-proxy.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `test/server-dashboard-proxy.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTaskboardServer } from "../server/index.mjs";
import { createCloudWorkerHarness } from "./helpers/cloud-worker-harness.mjs";
import { seedDashboardFixture } from "./helpers/dashboard-fixture.mjs";
import { startDashboardServer } from "../orchestration/dashboard/http-server.mjs";

async function findClosedPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
    probe.once("error", reject);
  });
}

async function startStalledUpstream() {
  return new Promise((resolve, reject) => {
    const upstream = createHttpServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"partial":');
      response.destroy();
    });
    upstream.listen(0, "127.0.0.1", () => {
      resolve({
        port: upstream.address().port,
        close: () => new Promise((done) => upstream.close(done)),
      });
    });
    upstream.once("error", reject);
  });
}

test("server proxies orchestration dashboard to the local orchestrator", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const dashboard = await startDashboardServer({ db: harness.db, port: 0 });
  t.after(() => dashboard.close());

  const directory = await mkdtemp(path.join(os.tmpdir(), "dashboard-proxy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = createTaskboardServer({
    dataDirectory: directory,
    orchestrationPort: dashboard.port,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/api/orchestration/dashboard`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.releasableVersions[0].name, "1.0.1");

  const taskResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/orchestration/dashboard/tasks/task-1`,
  );
  assert.equal(taskResponse.status, 200);
  const task = await taskResponse.json();
  assert.equal(task.prUrl, "https://github.com/example/pr/1");

  const post = await fetch(`http://127.0.0.1:${address.port}/api/orchestration/dashboard`, {
    method: "POST",
  });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
});

test("server returns 503 when the orchestrator dashboard is not running", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dashboard-proxy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const closedPort = await findClosedPort();
  const app = createTaskboardServer({
    dataDirectory: directory,
    orchestrationPort: closedPort,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/api/orchestration/dashboard`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "ORCHESTRATOR_UNAVAILABLE");
});

test("server maps upstream body-read failures to 503", async (t) => {
  const stalled = await startStalledUpstream();
  t.after(() => stalled.close());

  const directory = await mkdtemp(path.join(os.tmpdir(), "dashboard-proxy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = createTaskboardServer({
    dataDirectory: directory,
    orchestrationPort: stalled.port,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/api/orchestration/dashboard`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "ORCHESTRATOR_UNAVAILABLE");
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `node --test test/server-dashboard-proxy.test.mjs`
Expected: FAIL（`/api/orchestration/dashboard` 目前返回 404）。

- [ ] **Step 3: 实现端口解析与代理路由**

Modify `server/app.mjs`：

在 `resolveServerOptions` 的返回值里、`codexProcessesPath` 之后加入：

```js
    orchestrationPort: options.orchestrationPort ?? resolveOrchestrationPort(),
```

在 `resolvePort` 函数之后加入：

```js
export function resolveOrchestrationPort(value = process.env.CODEX_TASKBOARD_ORCHESTRATION_PORT ?? "47824") {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CODEX_TASKBOARD_ORCHESTRATION_PORT must be an integer between 1 and 65535");
  }
  return port;
}
```

在 `createTaskboardServer` 回调里、`if (pathname === "/api/workflow-capabilities") { ... }` 整个块之后、`let currentCloudConfig = null;` 之前加入：

```js
      if (
        pathname === "/api/orchestration/dashboard"
        || pathname.startsWith("/api/orchestration/dashboard/")
      ) {
        assertLoopbackRequest(request);
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const target = `http://127.0.0.1:${resolved.orchestrationPort}${pathname}${url.search}`;
        let upstream;
        let text;
        try {
          upstream = await fetch(target, {
            method: "GET",
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(5000),
          });
          text = await upstream.text();
        } catch (error) {
          console.error("orchestration dashboard proxy error:", error);
          throw new ApiError(
            503,
            "ORCHESTRATOR_UNAVAILABLE",
            "Orchestrator dashboard is not running",
            { port: resolved.orchestrationPort },
          );
        }
        const contentType = upstream.headers.get("content-type") ?? "application/json; charset=utf-8";
        response.writeHead(upstream.status, {
          "cache-control": "no-store",
          "content-type": contentType,
        });
        response.end(text);
        return;
      }
```

Modify `server/index.mjs`：

把导出语句改为：

```js
export { createTaskboardServer, resolveHost, resolveOrchestrationPort, resolvePort, resolveServerOptions } from "./app.mjs";
```

- [ ] **Step 4: 运行测试，验证通过**

Run: `node --test test/server-dashboard-proxy.test.mjs`
Expected: PASS（3 个测试全部通过）。

- [ ] **Step 5: 提交**

```bash
git add server/app.mjs server/index.mjs test/server-dashboard-proxy.test.mjs
git commit -m "feat: proxy orchestration dashboard through the taskboard server"
```
---

## Task 5: 前端类型与 API 客户端

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Test: `test/dashboard-api.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `test/dashboard-api.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../web/src/types.ts", import.meta.url), "utf8");

test("api client exposes orchestration dashboard endpoints", () => {
  assert.match(apiSource, /export async function getOrchestrationDashboard/);
  assert.match(apiSource, /\/api\/orchestration\/dashboard"/);
  assert.match(apiSource, /export async function getOrchestrationTaskDetail/);
  assert.match(apiSource, /\/api\/orchestration\/dashboard\/tasks\//);
  assert.match(apiSource, /export async function getOrchestrationVersionDetail/);
  assert.match(apiSource, /\/api\/orchestration\/dashboard\/versions\//);
});

test("types include dashboard payload and detail shapes", () => {
  for (const name of [
    "DashboardPayload",
    "ReleasableVersion",
    "PipelineCounts",
    "VersionProgress",
    "ActivityItem",
    "TaskDetail",
    "VersionDetail",
    "TimelineEntry",
  ]) {
    assert.match(typesSource, new RegExp(`export interface ${name}`));
  }
});

test("dashboard types carry contract-critical fields", () => {
  assert.match(typesSource, /export interface ReleasableVersion[\s\S]*?releaseFailed: boolean;/);
  assert.match(typesSource, /export interface DashboardPayload[\s\S]*?activity: ActivityItem\[\];/);
  assert.match(typesSource, /export interface TaskDetail[\s\S]*?acceptanceResult: "accepted" \| "rejected" \| null;/);
  assert.match(typesSource, /export interface VersionDetail[\s\S]*?manifest: \{[\s\S]*?checksum: string;/);
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `node --test test/dashboard-api.test.mjs`
Expected: FAIL（类型和 API 函数尚不存在）。

- [ ] **Step 3: 添加类型定义**

Modify `web/src/types.ts`，在文件末尾加入：

```ts
export type OrchestrationObjectType = "task" | "version";

export interface ReleasableVersion {
  id: string;
  name: string;
  taskCount: number;
  readyCount: number;
  releaseFailed: boolean;
  url: string;
}

export interface PipelineCounts {
  inbox: number;
  analyzing: number;
  waiting_info: number;
  ready_for_development: number;
  developing: number;
  ready_for_test: number;
  testing: number;
  ready_for_acceptance: number;
  accepting: number;
  ready_for_release: number;
  published: number;
  canceled: number;
}

export interface VersionProgress {
  id: string;
  name: string;
  status: string | null;
  taskCount: number;
  readyCount: number;
  releasable: boolean;
  releaseFailed: boolean;
}

export interface ActivityItem {
  time: string;
  objectType: OrchestrationObjectType;
  objectId: string;
  eventType: string;
  summary: string;
}

export interface DashboardPayload {
  releasableVersions: ReleasableVersion[];
  pipeline: PipelineCounts;
  versions: VersionProgress[];
  activity: ActivityItem[];
}

export interface TimelineEntry {
  time: string;
  eventType: string;
  summary: string;
  data: Record<string, unknown> | null;
}

export interface TaskDetail {
  id: string;
  name: string;
  targetVersion: string | null;
  status: string | null;
  assignee: string | null;
  updatedAt: string | null;
  summary: string | null;
  acceptanceCriteria: string[];
  changeSummary: string | null;
  prUrl: string | null;
  acceptanceResult: "accepted" | "rejected" | null;
  timeline: TimelineEntry[];
}

export interface VersionDetail {
  id: string;
  name: string;
  status: string | null;
  blocked: boolean;
  tasks: Array<{
    id: string;
    name: string;
    status: string | null;
    ready: boolean;
  }>;
  manifest: {
    versionId: string;
    taskIds: string[];
    createdAt: string;
    checksum: string;
  } | null;
}
```

- [ ] **Step 4: 添加 API 函数**

Modify `web/src/api.ts`：

在类型 import 列表中只加入实际使用的三个类型：

```ts
  DashboardPayload,
  TaskDetail,
  VersionDetail,
```

在 `getTaskboardRevision` 函数之后加入：

```ts
export async function getOrchestrationDashboard(signal?: AbortSignal): Promise<DashboardPayload> {
  return request<DashboardPayload>("/api/orchestration/dashboard", { signal });
}

export async function getOrchestrationTaskDetail(
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskDetail> {
  return request<TaskDetail>(
    `/api/orchestration/dashboard/tasks/${encodeURIComponent(taskId)}`,
    { signal },
  );
}

export async function getOrchestrationVersionDetail(
  versionId: string,
  signal?: AbortSignal,
): Promise<VersionDetail> {
  return request<VersionDetail>(
    `/api/orchestration/dashboard/versions/${encodeURIComponent(versionId)}`,
    { signal },
  );
}
```

注意：`api.ts` 的 import 只加入实际使用的类型；上面列出的 3 个之外的 dashboard 类型由组件文件直接 import。

- [ ] **Step 5: 运行测试与类型检查**

Run: `node --test test/dashboard-api.test.mjs`
Expected: PASS（3 个测试全部通过）。

Run: `npm run typecheck`
Expected: PASS，无 TypeScript 错误。

- [ ] **Step 6: 提交**

```bash
git add web/src/types.ts web/src/api.ts test/dashboard-api.test.mjs
git commit -m "feat: add dashboard types and api client"
```

---

## Task 6: Dashboard 组件与样式

**Files:**
- Create: `web/src/components/dashboard/Dashboard.tsx`
- Create: `web/src/components/dashboard/ReleaseActions.tsx`
- Create: `web/src/components/dashboard/PipelineOverview.tsx`
- Create: `web/src/components/dashboard/VersionProgress.tsx`
- Create: `web/src/components/dashboard/ActivityFeed.tsx`
- Create: `web/src/components/dashboard/DetailDrawer.tsx`
- Create: `web/src/components/dashboard/dashboard.css`
- Test: `test/dashboard-components.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `test/dashboard-components.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const dashboardSource = await readFile(
  new URL("../web/src/components/dashboard/Dashboard.tsx", import.meta.url),
  "utf8",
);
const releaseActionsSource = await readFile(
  new URL("../web/src/components/dashboard/ReleaseActions.tsx", import.meta.url),
  "utf8",
);
const pipelineSource = await readFile(
  new URL("../web/src/components/dashboard/PipelineOverview.tsx", import.meta.url),
  "utf8",
);
const versionProgressSource = await readFile(
  new URL("../web/src/components/dashboard/VersionProgress.tsx", import.meta.url),
  "utf8",
);
const activitySource = await readFile(
  new URL("../web/src/components/dashboard/ActivityFeed.tsx", import.meta.url),
  "utf8",
);
const drawerSource = await readFile(
  new URL("../web/src/components/dashboard/DetailDrawer.tsx", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../web/src/components/dashboard/dashboard.css", import.meta.url),
  "utf8",
);

test("dashboard container polls every 15 seconds and renders all four sections", () => {
  assert.match(dashboardSource, /export function Dashboard\(/);
  assert.match(dashboardSource, /const REFRESH_INTERVAL_MS = 15_000/);
  assert.match(dashboardSource, /setInterval\(/);
  assert.match(dashboardSource, /getOrchestrationDashboard/);
  assert.match(dashboardSource, /<ReleaseActions/);
  assert.match(dashboardSource, /<PipelineOverview/);
  assert.match(dashboardSource, /<VersionProgressList/);
  assert.match(dashboardSource, /<ActivityFeed/);
  assert.match(dashboardSource, /<DetailDrawer/);
});

test("release actions show ready versions and an empty state", () => {
  assert.match(releaseActionsSource, /export function ReleaseActions\(/);
  assert.match(releaseActionsSource, /版本发布（待你操作）/);
  assert.match(releaseActionsSource, /暂无待发布版本/);
  assert.match(releaseActionsSource, /在 ClickUp 操作/);
  assert.match(releaseActionsSource, /target="_blank"/);
  assert.match(releaseActionsSource, /可重试/);
});

test("pipeline overview maps canonical states to Chinese labels", () => {
  assert.match(pipelineSource, /export function PipelineOverview\(/);
  for (const label of ["收件箱", "分析中", "待补充信息", "待开发", "开发中", "待测试", "测试中", "待验收", "验收中", "待发布", "已发布"]) {
    assert.match(pipelineSource, new RegExp(label));
  }
});

test("version progress shows badges and progress metadata", () => {
  assert.match(versionProgressSource, /export function VersionProgressList\(/);
  assert.match(versionProgressSource, /可发布/);
  assert.match(versionProgressSource, /发布失败/);
  assert.match(versionProgressSource, /就绪/);
  assert.match(versionProgressSource, /version-progress-track/);
});

test("activity feed renders time, object type and summary", () => {
  assert.match(activitySource, /export function ActivityFeed\(/);
  assert.match(activitySource, /activity-summary/);
  assert.match(activitySource, /toLocaleTimeString/);
});

test("detail drawer supports task and version bodies", () => {
  assert.match(drawerSource, /export function DetailDrawer\(/);
  assert.match(drawerSource, /任务详情/);
  assert.match(drawerSource, /版本详情/);
  assert.match(drawerSource, /TaskDetailBody/);
  assert.match(drawerSource, /VersionDetailBody/);
  assert.match(drawerSource, /状态时间线/);
  assert.match(drawerSource, /Manifest/);
});

test("dashboard styles define layout, badges and drawer classes", () => {
  for (const selector of [
    ".dashboard",
    ".dashboard-section",
    ".release-actions",
    ".pipeline-grid",
    ".version-progress",
    ".activity-feed",
    ".detail-drawer",
    ".badge-releasable",
    ".badge-failed",
  ]) {
    assert.match(styles, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `node --test test/dashboard-components.test.mjs`
Expected: FAIL with `ENOENT`（组件文件尚不存在）。

- [ ] **Step 3: 实现组件与样式**

Create `web/src/components/dashboard/ReleaseActions.tsx`:

```tsx
import type { ReleasableVersion } from "../../types";

export function ReleaseActions({ versions }: { versions: ReleasableVersion[] }) {
  return (
    <section className="dashboard-section release-actions" aria-labelledby="release-actions-title">
      <div className="dashboard-section-heading">
        <h2 id="release-actions-title">版本发布（待你操作）</h2>
        <span className="dashboard-section-count">{versions.length}</span>
      </div>
      {versions.length === 0 ? (
        <p className="release-actions-empty">暂无待发布版本</p>
      ) : (
        <ul className="release-action-list">
          {versions.map((version) => (
            <li className="release-action-card" key={version.id}>
              <div className="release-action-copy">
                <strong>{version.name}</strong>
                <span>{version.readyCount}/{version.taskCount} 个任务已就绪</span>
              </div>
              {version.releaseFailed ? (
                <span className="badge badge-failed">发布失败 · 可重试</span>
              ) : (
                <span className="badge badge-releasable">可发布</span>
              )}
              <a
                className="button release-action-link"
                href={version.url}
                target="_blank"
                rel="noreferrer"
              >
                在 ClickUp 操作
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

Create `web/src/components/dashboard/PipelineOverview.tsx`:

```tsx
import type { PipelineCounts } from "../../types";

const PIPELINE_LABELS: Array<{ key: keyof PipelineCounts; label: string }> = [
  { key: "inbox", label: "收件箱" },
  { key: "analyzing", label: "分析中" },
  { key: "waiting_info", label: "待补充信息" },
  { key: "ready_for_development", label: "待开发" },
  { key: "developing", label: "开发中" },
  { key: "ready_for_test", label: "待测试" },
  { key: "testing", label: "测试中" },
  { key: "ready_for_acceptance", label: "待验收" },
  { key: "accepting", label: "验收中" },
  { key: "ready_for_release", label: "待发布" },
  { key: "published", label: "已发布" },
];

export function PipelineOverview({ pipeline }: { pipeline: PipelineCounts }) {
  return (
    <section className="dashboard-section pipeline-overview" aria-labelledby="pipeline-title">
      <div className="dashboard-section-heading">
        <h2 id="pipeline-title">流水线总览</h2>
      </div>
      <ol className="pipeline-grid">
        {PIPELINE_LABELS.map((item) => {
          const count = pipeline[item.key];
          const tone = item.key === "waiting_info"
            ? "warning"
            : item.key === "ready_for_release"
              ? "success"
              : "neutral";
          return (
            <li
              className={`pipeline-cell pipeline-${tone}${count === 0 ? " is-empty" : ""}`}
              key={item.key}
            >
              <span className="pipeline-count">{count}</span>
              <span className="pipeline-label">{item.label}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
```

Create `web/src/components/dashboard/VersionProgress.tsx`:

```tsx
import type { VersionProgress } from "../../types";

const VERSION_STATUS_LABELS: Record<string, string> = {
  planning: "规划中",
  active: "进行中",
  ready_for_release: "待发布",
  releasing: "发布中",
  release_failed: "发布失败",
  published: "已发布",
  canceled: "已取消",
};

export function VersionProgressList({
  versions,
  onOpen,
}: {
  versions: VersionProgress[];
  onOpen: (version: VersionProgress) => void;
}) {
  return (
    <section className="dashboard-section version-progress" aria-labelledby="version-progress-title">
      <div className="dashboard-section-heading">
        <h2 id="version-progress-title">版本进度</h2>
        <span className="dashboard-section-count">{versions.length}</span>
      </div>
      {versions.length === 0 ? (
        <p className="version-progress-empty">暂无版本</p>
      ) : (
        <ul className="version-progress-list">
          {versions.map((version) => {
            const percent = version.taskCount === 0
              ? 0
              : Math.round((version.readyCount / version.taskCount) * 100);
            return (
              <li key={version.id}>
                <button
                  className="version-progress-card"
                  type="button"
                  onClick={() => onOpen(version)}
                >
                  <span className="version-progress-name">{version.name}</span>
                  {version.releasable && <span className="badge badge-releasable">可发布</span>}
                  {version.releaseFailed && <span className="badge badge-failed">发布失败</span>}
                  <span className={`badge badge-status badge-status-${version.status ?? "unknown"}`}>
                    {VERSION_STATUS_LABELS[version.status ?? ""] ?? version.status ?? "未知"}
                  </span>
                  <span className="version-progress-track" aria-hidden="true">
                    <span className="version-progress-fill" style={{ width: `${percent}%` }} />
                  </span>
                  <span className="version-progress-meta">{version.readyCount}/{version.taskCount} 就绪</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
```

Create `web/src/components/dashboard/ActivityFeed.tsx`:

```tsx
import type { ActivityItem } from "../../types";

export function ActivityFeed({
  items,
  onOpen,
}: {
  items: ActivityItem[];
  onOpen: (item: ActivityItem) => void;
}) {
  return (
    <section className="dashboard-section activity-feed" aria-labelledby="activity-title">
      <div className="dashboard-section-heading">
        <h2 id="activity-title">实时活动</h2>
        <span className="dashboard-section-count">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="activity-empty">暂无活动</p>
      ) : (
        <ol className="activity-list">
          {items.map((item, index) => (
            <li key={`${item.objectId}-${item.time}-${index}`}>
              <button className="activity-item" type="button" onClick={() => onOpen(item)}>
                <time className="activity-time">
                  {new Date(item.time).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                <span className={`activity-object activity-${item.objectType}`}>
                  {item.objectType === "version" ? "版本" : "任务"}
                </span>
                <span className="activity-summary">{item.summary}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
```

Create `web/src/components/dashboard/DetailDrawer.tsx`:

```tsx
import type { TaskDetail, VersionDetail } from "../../types";

interface DetailDrawerProps {
  kind: "task" | "version";
  detail: TaskDetail | VersionDetail | null;
  onClose: () => void;
}

export function DetailDrawer({ kind, detail, onClose }: DetailDrawerProps) {
  return (
    <aside className="detail-drawer" aria-label="详情" role="dialog">
      <header className="detail-drawer-header">
        <strong>{kind === "task" ? "任务详情" : "版本详情"}</strong>
        <button
          className="icon-button"
          type="button"
          aria-label="关闭详情"
          title="关闭"
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      {!detail ? (
        <p className="detail-drawer-loading">正在加载…</p>
      ) : kind === "task" ? (
        <TaskDetailBody detail={detail as TaskDetail} />
      ) : (
        <VersionDetailBody detail={detail as VersionDetail} />
      )}
    </aside>
  );
}

function TaskDetailBody({ detail }: { detail: TaskDetail }) {
  return (
    <div className="detail-drawer-body">
      <h3>{detail.name}</h3>
      <dl className="detail-fields">
        <div><dt>目标版本</dt><dd>{detail.targetVersion ?? "未设置"}</dd></div>
        <div><dt>当前状态</dt><dd>{detail.status ?? "未知"}</dd></div>
        <div><dt>负责人</dt><dd>{detail.assignee ?? "未设置"}</dd></div>
      </dl>
      {detail.prUrl && (
        <p className="detail-link">
          <a href={detail.prUrl} target="_blank" rel="noreferrer">查看 PR</a>
        </p>
      )}
      {detail.summary && (
        <section className="detail-block">
          <h4>执行摘要</h4>
          <p>{detail.summary}</p>
        </section>
      )}
      {detail.acceptanceCriteria.length > 0 && (
        <section className="detail-block">
          <h4>验收标准</h4>
          <ol>
            {detail.acceptanceCriteria.map((criterion, index) => (
              <li key={index}>{criterion}</li>
            ))}
          </ol>
        </section>
      )}
      {detail.changeSummary && (
        <section className="detail-block">
          <h4>改动摘要</h4>
          <p>{detail.changeSummary}</p>
        </section>
      )}
      <section className="detail-block">
        <h4>状态时间线</h4>
        <ol className="detail-timeline">
          {detail.timeline.map((entry, index) => (
            <li key={`${entry.time}-${index}`}>
              <time>{new Date(entry.time).toLocaleString("zh-CN")}</time>
              <span>{entry.summary}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function VersionDetailBody({ detail }: { detail: VersionDetail }) {
  return (
    <div className="detail-drawer-body">
      <h3>{detail.name}</h3>
      <dl className="detail-fields">
        <div><dt>状态</dt><dd>{detail.status ?? "未知"}</dd></div>
        <div><dt>发布阻塞</dt><dd>{detail.blocked ? "是" : "否"}</dd></div>
      </dl>
      <section className="detail-block">
        <h4>任务清单</h4>
        {detail.tasks.length === 0 ? (
          <p>暂无任务</p>
        ) : (
          <ul className="detail-task-list">
            {detail.tasks.map((task) => (
              <li key={task.id}>
                <span>{task.name}</span>
                <span className={task.ready ? "detail-ready" : ""}>
                  {task.ready ? "就绪" : task.status ?? "未知"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {detail.manifest && (
        <section className="detail-block">
          <h4>Manifest</h4>
          <p className="detail-monospace">
            checksum: {detail.manifest.checksum}
            <br />
            createdAt: {detail.manifest.createdAt}
          </p>
        </section>
      )}
    </div>
  );
}
```

Create `web/src/components/dashboard/Dashboard.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { LinearIcon } from "../LinearIcon";
import {
  ApiError,
  getOrchestrationDashboard,
  getOrchestrationTaskDetail,
  getOrchestrationVersionDetail,
} from "../../api";
import type {
  ActivityItem,
  DashboardPayload,
  TaskDetail,
  VersionDetail,
  VersionProgress,
} from "../../types";
import { ActivityFeed } from "./ActivityFeed";
import { DetailDrawer } from "./DetailDrawer";
import { PipelineOverview } from "./PipelineOverview";
import { ReleaseActions } from "./ReleaseActions";
import { VersionProgressList } from "./VersionProgress";
import "./dashboard.css";

const REFRESH_INTERVAL_MS = 15_000;

type DrawerState =
  | { kind: "task"; id: string }
  | { kind: "version"; id: string }
  | null;

export function Dashboard() {
  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [detail, setDetail] = useState<TaskDetail | VersionDetail | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await getOrchestrationDashboard(signal);
      setPayload(next);
      setError(null);
      setLastUpdated(Date.now());
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      setError(caught instanceof ApiError ? caught.message : "无法加载驾驶舱数据");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    if (!drawer) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    void (drawer.kind === "task"
      ? getOrchestrationTaskDetail(drawer.id, controller.signal)
      : getOrchestrationVersionDetail(drawer.id, controller.signal)
    )
      .then(setDetail)
      .catch((caught) => {
        if (caught instanceof Error && caught.name === "AbortError") return;
        setDetail(null);
      });
    return () => controller.abort();
  }, [drawer]);

  function openActivity(item: ActivityItem) {
    setDrawer({ kind: item.objectType, id: item.objectId });
  }

  function openVersion(version: VersionProgress) {
    setDrawer({ kind: "version", id: version.id });
  }

  return (
    <div className="dashboard" aria-label="运营驾驶舱">
      <header className="dashboard-header">
        <div>
          <h1>运营驾驶舱</h1>
          <p className="dashboard-subtitle">
            {lastUpdated
              ? `最近更新 ${new Date(lastUpdated).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}`
              : "等待首次同步…"}
          </p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="刷新"
          title="刷新"
          onClick={() => void load()}
        >
          <LinearIcon name="recurrence" />
        </button>
      </header>

      {error && (
        <div className="dashboard-error" role="alert">
          <strong>数据加载失败</strong>
          <span>{error}</span>
        </div>
      )}

      {!payload && !error && (
        <div className="dashboard-loading" aria-busy="true">正在加载驾驶舱…</div>
      )}

      {payload && (
        <>
          <ReleaseActions versions={payload.releasableVersions} />
          <PipelineOverview pipeline={payload.pipeline} />
          <VersionProgressList versions={payload.versions} onOpen={openVersion} />
          <ActivityFeed items={payload.activity} onOpen={openActivity} />
        </>
      )}

      {drawer && (
        <DetailDrawer
          kind={drawer.kind}
          detail={detail}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}
```

Create `web/src/components/dashboard/dashboard.css`:

```css
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: 100%;
  max-width: 980px;
  margin: 0 auto;
  padding: 20px 24px 40px;
  overflow-y: auto;
}

.dashboard-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.dashboard-header h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: 0;
}

.dashboard-subtitle {
  margin: 2px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}

.dashboard-loading,
.dashboard-error {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
}

.dashboard-error {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--danger-soft);
  border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
  color: var(--danger);
}

.dashboard-section,
.release-actions,
.version-progress,
.activity-feed {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: var(--card-shadow);
}

.dashboard-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px 10px;
  border-bottom: 1px solid var(--border);
}

.dashboard-section-heading h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0;
}

.dashboard-section-count {
  min-width: 22px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--surface-muted);
  color: var(--text-secondary);
  font-size: 11px;
  text-align: center;
}

.badge {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 550;
  white-space: nowrap;
}

.badge-releasable {
  background: color-mix(in srgb, var(--success) 16%, transparent);
  color: var(--success);
}

.badge-failed {
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: var(--danger);
}

.badge-status {
  background: var(--surface-muted);
  color: var(--text-secondary);
}

.release-actions-empty,
.version-progress-empty,
.activity-empty {
  margin: 0;
  padding: 18px 16px;
  color: var(--text-tertiary);
}

.release-action-list,
.version-progress-list,
.activity-list {
  list-style: none;
  margin: 0;
  padding: 6px;
}

.release-action-card {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 8px 10px;
}

.release-action-card + .release-action-card {
  border-top: 1px solid var(--border);
}

.release-action-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.release-action-copy strong {
  font-size: 13px;
  font-weight: 650;
}

.release-action-copy span {
  color: var(--text-secondary);
  font-size: 12px;
}

.release-action-link {
  margin-left: auto;
  white-space: nowrap;
}

.pipeline-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(74px, 1fr));
  gap: 6px;
  list-style: none;
  margin: 0;
  padding: 10px;
}

.pipeline-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-height: 58px;
  padding: 8px 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-muted);
}

.pipeline-cell.is-empty {
  opacity: 0.45;
}

.pipeline-warning {
  border-color: color-mix(in srgb, var(--warning) 55%, var(--border));
  background: color-mix(in srgb, var(--warning) 12%, var(--surface));
}

.pipeline-success {
  border-color: color-mix(in srgb, var(--success) 55%, var(--border));
  background: color-mix(in srgb, var(--success) 12%, var(--surface));
}

.pipeline-count {
  font-size: 18px;
  font-weight: 650;
  line-height: 1.2;
}

.pipeline-label {
  color: var(--text-secondary);
  font-size: 11px;
  text-align: center;
}

.version-progress-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.version-progress-card {
  display: grid;
  grid-template-columns: minmax(90px, auto) auto auto 1fr auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  text-align: left;
}

.version-progress-card:hover {
  background: var(--surface-hover);
}

.version-progress-name {
  font-size: 13px;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.version-progress-track {
  display: block;
  width: 100%;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--surface-muted);
}

.version-progress-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
}

.version-progress-meta {
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
}

.activity-list {
  display: flex;
  flex-direction: column;
}

.activity-item {
  display: grid;
  grid-template-columns: 52px 36px 1fr;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
}

.activity-item:hover {
  background: var(--surface-hover);
}

.activity-time {
  color: var(--text-tertiary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.activity-object {
  font-size: 11px;
  color: var(--text-secondary);
}

.activity-task {
  color: var(--accent);
}

.activity-version {
  color: var(--success);
}

.activity-summary {
  color: var(--text-primary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-drawer {
  position: fixed;
  inset: 0 0 0 auto;
  width: min(460px, 92vw);
  border-left: 1px solid var(--border-strong);
  background: var(--surface-raised);
  box-shadow: var(--dialog-shadow);
  z-index: 40;
  overflow-y: auto;
}

.detail-drawer-header {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-raised);
  z-index: 1;
}

.detail-drawer-header strong {
  font-size: 13px;
  font-weight: 650;
}

.detail-drawer-loading {
  padding: 18px 16px;
  color: var(--text-tertiary);
}

.detail-drawer-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 16px 28px;
}

.detail-drawer-body h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0;
  overflow-wrap: anywhere;
}

.detail-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
  margin: 0;
}

.detail-fields div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.detail-fields dt {
  color: var(--text-tertiary);
  font-size: 11px;
}

.detail-fields dd {
  margin: 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.detail-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.detail-block h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0;
}

.detail-block p,
.detail-block ol,
.detail-block ul {
  margin: 0;
  padding-left: 0;
  font-size: 12px;
}

.detail-block ol,
.detail-block ul {
  list-style-position: inside;
}

.detail-timeline {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.detail-timeline li {
  display: flex;
  gap: 8px;
  color: var(--text-secondary);
}

.detail-timeline time {
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.detail-task-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-task-list li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.detail-ready {
  color: var(--success);
}

.detail-monospace {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11px;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `node --test test/dashboard-components.test.mjs`
Expected: PASS（7 个测试全部通过）。

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/dashboard test/dashboard-components.test.mjs
git commit -m "feat: add operations dashboard components"
```
---

## Task 7: App 默认视图切换为 Dashboard

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `test/board-views.test.mjs`
- Test: `test/dashboard-view.test.mjs`

- [ ] **Step 1: 更新旧断言并写新失败测试**

Modify `test/board-views.test.mjs`，把第一个测试替换为：

```js
test("the taskboard defaults to the operations dashboard without a board entry", () => {
  assert.match(appSource, /type BoardView = "issues" \| "workflow"/);
  assert.match(appSource, /useState<"dashboard" \| "issues">\("dashboard"\)/);
  assert.match(appSource, /viewMode === "dashboard" \? <Dashboard \/>/);
  assert.doesNotMatch(appSource, />\s*议题看板\s*<\/button>/);
  assert.doesNotMatch(appSource, /aria-pressed=\{boardView === "issues"\}/);
});
```

Create `test/dashboard-view.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");

test("dashboard is the default view with no old board entry", () => {
  assert.match(appSource, /import \{ Dashboard \} from "\.\/components\/dashboard\/Dashboard"/);
  assert.match(appSource, /useState<"dashboard" \| "issues">\("dashboard"\)/);
  assert.match(appSource, /运营驾驶舱/);
  assert.match(appSource, /viewMode === "dashboard" \? <Dashboard \/> : \(/);
  assert.match(appSource, /viewMode === "issues" && selectedProjectId \? \(/);
  assert.match(appSource, /viewMode === "issues" && <div className="project-nav">/);
  assert.match(appSource, /event\.key\.toLowerCase\(\) === "c"[\s\S]*?viewMode === "issues"[\s\S]*?selectedProjectId[\s\S]*?boardView === "issues"/);
  assert.match(appSource, /event\.key === "\/" && viewMode === "issues" && !detailTaskId && selectedProjectId && boardView === "issues"/);
  assert.match(appSource, /!editor[\s\S]*?viewMode === "issues"/);
  assert.match(appSource, /\[boardView, contextMenu, detailTaskId, editor, projectMenuOpen, selectedProjectId, viewMode\]/);
  assert.doesNotMatch(appSource, />\s*议题看板\s*<\/button>/);
});

test("dashboard keeps an embedded drag region without rendering board chrome", () => {
  assert.match(appSource, /viewMode === "dashboard" \? \(/);
  assert.match(appSource, /className="workspace-header">\n\s*<div ref=\{dragRegionRef\} className="workspace-drag-region"/);
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `node --test test/board-views.test.mjs test/dashboard-view.test.mjs`
Expected: FAIL（App.tsx 尚未切换默认视图）。

- [ ] **Step 3: 修改 App.tsx**

Modify `web/src/App.tsx`：

1. 在组件 import 区加入：

```tsx
import { Dashboard } from "./components/dashboard/Dashboard";
```

2. 在 `const [boardView, setBoardView] = useState<BoardView>("issues");` 之后加入：

```tsx
  const [viewMode] = useState<"dashboard" | "issues">("dashboard");
```

3. 把侧边栏主导航按钮（当前是 `myIssues` 图标 + “议题” + `nav-count`）替换为：

```tsx
            <button className="nav-item active" type="button" aria-current="page">
              <span className="nav-glyph" aria-hidden="true">
                <LinearIcon name="dashboard" />
              </span>
              运营驾驶舱
            </button>
```

4. 把 `<main className="workspace">` 里的项目头部分支：

```tsx
        {selectedProjectId ? (
          <header className="workspace-header">
```

改为：

```tsx
        {viewMode === "issues" && selectedProjectId ? (
          <header className="workspace-header">
```

并把对应的 else 分支：

```tsx
        ) : (
          <div ref={dragRegionRef} className="home-window-drag-region" aria-hidden="true" />
        )}
```

改为：

```tsx
        ) : viewMode === "dashboard" ? (
          <header className="workspace-header">
            <div ref={dragRegionRef} className="workspace-drag-region" aria-hidden="true" />
          </header>
        ) : (
          <div ref={dragRegionRef} className="home-window-drag-region" aria-hidden="true" />
        )}
```

5. 把 board-toolbar 的条件：

```tsx
        {selectedProjectId && !detailTask && <div className="board-toolbar">
```

改为：

```tsx
        {viewMode === "issues" && selectedProjectId && !detailTask && <div className="board-toolbar">
```

6. 删除 board-toolbar 里的整个 `view-tabs` div（含“议题看板”和“节点模式”按钮），保留 toolbar-tools 部分。

7. 隐藏非 embedded 侧边栏里的项目导航（驾驶舱模式不显示项目列表，AI 聊天保留）：

```tsx
          <div className="project-nav">
```

改为：

```tsx
          {viewMode === "issues" && <div className="project-nav">
```

并在该项目导航块的 `</div>` 结束标签后补一个 `)}`。

8. 给旧看板快捷键加 `viewMode === "issues"` 守卫：

`c` 快捷键条件改为：

```tsx
      if (
        event.key.toLowerCase() === "c"
        && !event.metaKey
        && !event.ctrlKey
        && viewMode === "issues"
        && selectedProjectId
        && boardView === "issues"
      ) {
```

`/` 快捷键条件改为：

```tsx
      if (event.key === "/" && viewMode === "issues" && !detailTaskId && selectedProjectId && boardView === "issues") {
```

`cmd+z` 撤销条件补上 `viewMode === "issues"`：

```tsx
        && !editor
        && viewMode === "issues"
```

`handleShortcut` 的 effect 依赖数组改为：

```tsx
  }, [boardView, contextMenu, detailTaskId, editor, projectMenuOpen, selectedProjectId, viewMode]);
```

9. 在主内容条件 `{!selectedProjectId ? (` 之前插入：

```tsx
        {viewMode === "dashboard" ? <Dashboard /> : (
        <>{!selectedProjectId ? (
```

并在 `</main>` 之前、原内容链结束后补上：

```tsx
        </>)}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `node --test test/board-views.test.mjs test/dashboard-view.test.mjs`
Expected: PASS（两个文件全部通过）。

Run: `npm run typecheck`
Expected: PASS。

Run: `npm run build:web`
Expected: PASS，`dist/web` 生成成功。

- [ ] **Step 5: 提交**

```bash
git add web/src/App.tsx test/board-views.test.mjs test/dashboard-view.test.mjs
git commit -m "feat: make operations dashboard the default taskboard view"
```

---

## Task 8: 全量验证

**Files:**
- 无新增代码；如验证发现问题，按对应 Task 修。

- [ ] **Step 1: 运行全量检查**

Run: `npm run check`
Expected: `npm run typecheck`、`npm run build`、`npm test` 全部 PASS。

- [ ] **Step 2: 本地联调（已配置 `.data/orchestration.json` 时）**

在终端 A 启动 orchestrator：

```bash
node scripts/orchestrator.mjs
```

Expected: 日志出现 `dashboard listening on http://127.0.0.1:47824`。

在终端 B 验证 orchestrator 端点：

```bash
curl -s http://127.0.0.1:47824/api/orchestration/dashboard | head -c 400
```

Expected: 返回合法 JSON，`versions` 数组存在。任务/版本详情端点已由自动化测试覆盖（`test/orchestration/dashboard-http.test.mjs`）。

在终端 C 启动 taskboard server：

```bash
node server/index.mjs
```

再验证代理：

```bash
curl -s http://127.0.0.1:47823/api/orchestration/dashboard | head -c 400
```

Expected: 与 orchestrator 直连返回相同结构。若 `47823` 已被占用，先停掉占用进程或改用 `CODEX_TASKBOARD_PORT`。

打开浏览器访问 `http://127.0.0.1:47823`，Expected：默认显示运营驾驶舱，无旧看板入口，页面每 15 秒自动刷新，点击版本/任务可打开右侧抽屉。

- [ ] **Step 3: 处理发现的问题并重新验证**

如联调发现数据或布局问题，回到对应 Task 修复，然后重新运行 `npm run check` 与 Step 2 的验证。

- [ ] **Step 4: 收尾提交**

如有修复产生的改动：

```bash
git add -A
git commit -m "fix: polish operations dashboard after integration verification"
```

如没有改动，跳过本步，直接结束。

---

## 自审记录

**Spec coverage：**
- 版本发布待办区：Task 1（`releasableVersions`）＋ Task 6（`ReleaseActions`）。
- 流水线总览：Task 1（`pipeline`）＋ Task 6（`PipelineOverview`）。
- 版本进度：Task 1（`versions`）＋ Task 6（`VersionProgressList`）。
- 实时活动：Task 1（`activity`）＋ Task 6（`ActivityFeed`）。
- 详情抽屉：Task 1（`buildTaskDetail`／`buildVersionDetail`）＋ Task 6（`DetailDrawer`）。
- 可发布判定与 `checkVersionGate` 对齐（全部任务就绪、无 open task blocker、版本未阻塞、非 released/canceled/releasing）：Task 1。
- 发布失败版本进入待办区并标记「可重试」：Task 1（`releaseFailed` 字段）＋ Task 6（`ReleaseActions`）。
- 代理端点仅本机 loopback：Task 4。
- 旧看板快捷键与项目导航在驾驶舱模式隐藏（AI 聊天保留）：Task 7。
- 活动流开发 PR 按事件 `command_id` 精确关联对应 runner 作业：Task 1。
- 独立轮询：Task 6（`REFRESH_INTERVAL_MS = 15_000`）。
- orchestrator 只读端点：Task 3。
- server 代理：Task 4。
- 默认视图替换、无旧入口：Task 7。
- YAGNI：无任务编辑/创建、无测试/验收操作入口、无跨版本权限。

**Placeholder scan：** 每个代码步骤都有完整文件内容或精确 diff；无 TBD／“适当处理错误”／“类似 Task N”等占位。

**Type consistency：** `buildDashboard` 返回 `{ releasableVersions, pipeline, versions, activity }`，与 `DashboardPayload` 一致；`ReleasableVersion` 含 `releaseFailed`，与 `ReleaseActions` 的「可重试」徽标一致；`buildTaskDetail` 返回字段与 `TaskDetail` 一致；`buildVersionDetail` 返回字段与 `VersionDetail` 一致；组件 props（`versions`、`items`、`detail`、`onOpen`、`onClose`）在 Task 6 内部保持一致。

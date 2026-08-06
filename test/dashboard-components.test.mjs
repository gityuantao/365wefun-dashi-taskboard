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

test("dashboard renders the orchestration master switch", () => {
  assert.match(dashboardSource, /getOrchestrationControl/);
  assert.match(dashboardSource, /setOrchestrationControl/);
  assert.match(dashboardSource, /编排总开关/);
  assert.match(dashboardSource, /board-setting-switch/);
  assert.match(dashboardSource, /运行中|已暂停/);
  assert.match(dashboardSource, /project-automation-trigger/);
  assert.match(dashboardSource, /编排运行中|编排已暂停/);
  assert.match(dashboardSource, /createPortal/);
  assert.match(dashboardSource, /project-automation-menu/);
});

test("polish states and interactions are present", () => {
  assert.match(releaseActionsSource, /暂无待发布版本，所有版本都在推进中/);
  assert.match(versionProgressSource, /未就绪/);
  assert.match(versionProgressSource, /存在阻塞任务/);
  assert.match(activitySource, /刚刚|分钟前|toLocaleTimeString/);
  assert.match(drawerSource, /Escape/);
  assert.match(dashboardSource, /更新中/);
  assert.match(styles, /\.version-progress-fill\.is-complete/);
  assert.match(styles, /\.detail-drawer-overlay/);
});

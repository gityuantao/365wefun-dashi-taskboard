# 运营驾驶舱（MVP 第二阶段）设计

日期：2026-08-06
状态：待评审

## 1. 背景与目标

MVP 第一阶段完成了 ClickUp 驱动的自动化编排（分析→开发→测试→验收→发布），
但侧边栏页面仍是通用的任务看板。第二阶段把侧边栏入口换成**运营驾驶舱**：
一个给狗哥本人看的单页视图，核心回答两个问题——

1. 现在需要我做什么？（只有版本发布需要狗哥在 ClickUp 手动操作）
2. 系统进展到哪了？

旧看板不再保留入口。

## 2. 角色分工（决定页面内容）

| 环节 | 谁操作 |
|------|--------|
| 分析 / 开发 / 验收 / 发布执行 | 系统（AI）自动 |
| 测试 | 测试人员在 ClickUp 操作 |
| 待补充信息 | 狗哥在 ClickUp 回复 + 改回分析中 |
| **版本发布** | **狗哥在 ClickUp 把版本改为发布中** |

因此「待你操作」区**只展示版本发布**相关的待办，不展示测试/验收。

## 3. 页面布局（单页，从上到下）

```
┌─────────────────────────────────────────────┐
│  版本发布（待你操作，高亮区）                │
│  [1.0.1 可发布 → 点此在 ClickUp 操作]        │
├─────────────────────────────────────────────┤
│  流水线总览（进度条）                       │
│  收件箱 → 分析 → 待补充 → 开发 → 测试 →     │
│  验收 → 待发布 → 已发布                     │
├─────────────────────────────────────────────┤
│  版本进度（卡片列表）                       │
│  [1.0.1  ██████░░ 5/6 就绪  状态:进行中]     │
├─────────────────────────────────────────────┤
│  实时活动（最近 20 条）                     │
│  10:03 任务 xxx 验收通过，进入待发布         │
│  10:01 版本 1.0.1 发布成功                  │
└─────────────────────────────────────────────┘
```

## 4. 各区块详细定义

### 4.1 版本发布（待你操作）

- 展示**所有满足发布条件但尚未发布的版本**：版本内全部任务处于 `ready_for_release`，
  无阻塞，且版本自身未 `published`。
- 每个版本一张卡片：版本名、任务就绪数/总数、一个「在 ClickUp 操作」链接
  （跳转 `https://app.clickup.com/.../版本-Sandbox`，狗哥把状态改为「发布中」）。
- 无待发布版本时显示「暂无待发布版本」占位，区域不喧宾夺主。

### 4.2 流水线总览

- 一行状态格：收件箱、分析中、待补充信息、待开发、开发中、待测试、测试中、
  待验收、验收中、待发布、已发布。
- 每格显示当前数量；颜色：待补充信息=黄色（需要关注）、待发布=绿色、
  其余=中性色；数量为 0 的格子淡化。
- 待补充信息属于"系统进展"展示，不放进待你操作区（避免打扰）。

### 4.3 版本进度

- 每个版本一条：版本名、状态徽标（进行中/待发布/已发布/发布失败）、
  任务就绪进度条（就绪数/总数）、关联任务数。
- 就绪且未发布的版本显示「可发布」徽标。
- 发布失败的版本显示红色「发布失败」徽标。

### 4.4 实时活动

- 最近 20 条 `runner_jobs` 完成记录 + 版本状态变化，倒序。
- 每条显示：时间、对象（任务/版本）、动作摘要（如「开发完成」「验收通过」）。
- 来源：`runner_jobs.result` 与 `orchestration_events`。

## 5. 交互

- 点击任务/版本条目 → 右侧抽屉显示详情：
  - 任务：名称、目标版本、当前状态、执行摘要、验收标准、PR 链接、证据链接、状态时间线。
  - 版本：版本名、状态、任务清单（含各自状态）、Manifest（如有）。
- 数据自动刷新：前端独立定时轮询 dashboard 端点（10~30 秒一次），
  不依赖现有 revision 机制。

## 6. 技术方案

### 6.1 后端

- 在 **orchestrator 进程内**新增只读聚合端点 `GET /api/orchestration/dashboard`
  （orchestrator 已持有编排 D1 连接，避免 server 直接打开同一 sqlite 造成并发读写问题）。
- server 作为反向代理转发该请求给前端（新增 `GET /api/orchestration/dashboard` 代理路由）。
- 数据源：`orchestration_aggregates`、`clickup_snapshots`、`runner_jobs`、
  `orchestration_events`、`release_manifests`。
  - 返回：
    ```json
    {
      "releasableVersions": [{ "id", "name", "taskCount", "readyCount", "url" }],
      "pipeline": { "inbox": 0, "analyzing": 2, "waiting_info": 0, ... },
      "versions": [{ "id", "name", "status", "taskCount", "readyCount", "releasable" }],
      "activity": [{ "time", "objectType", "objectId", "eventType", "summary" }]
    }
    ```
- **不使用现有 `/api/revisions` 轮询**：该机制仅在 cloud 模式启用，本地 orchestrator
  是 local 模式，轮询关闭。dashboard 使用**独立的前端定时轮询**（10~30 秒一次）
  直接拉取 dashboard 端点。

### 6.1.1 任务/版本详情数据源

- `clickup_snapshots` 仅含 `id/name/status/targetVersion/assignee/updatedAt`，
  不含执行摘要、验收标准、PR、证据。这些详情从 **`runner_jobs.result`** 聚合：
  - 分析作业结果：`summary.scope`（执行摘要）、`summary.acceptance_criteria`（验收标准）
  - 开发作业结果：`pr.url`（PR 链接）、`changeSummary`
  - 验收作业结果：`result`（accepted/rejected）
- 状态时间线从 `orchestration_events` 读取（`occurred_at`、`type`、`data.from/to`）。
- 抽屉按 taskId 查询该任务最近一次各类型作业结果 + 事件时间线。

### 6.1.2 实时活动数据源

- 以 `orchestration_events` 为主：它记录全部任务/版本状态变化
  （含 actor、occurred_at、event type、from/to），可按时间倒序取最近 20 条。
- `runner_jobs` 仅补充作业摘要（开发 PR、验收结论），按 commandId 关联事件。

### 6.2 前端

- `web/src` 新增 `Dashboard.tsx` 及子组件：
  - `ReleaseActions.tsx`（版本发布待办区）
  - `PipelineOverview.tsx`（流水线）
  - `VersionProgress.tsx`（版本进度列表）
  - `ActivityFeed.tsx`（实时活动）
  - `DetailDrawer.tsx`（右侧详情抽屉）
- `App.tsx` 默认视图改为 Dashboard，删除旧看板入口（保留代码文件，不渲染）。
- 样式沿用 `styles.css` 的现有设计语言（深色、紧凑、线性风格）。

## 7. 不做的事（YAGNI）

- 不做任务编辑/创建（那是 ClickUp 的职责）。
- 不做测试/验收的操作入口（测试在 ClickUp 由测试人员操作，验收由系统自动）。
- 不展示 ClickUp 自带看板。
- 不做跨版本发布权限控制（沿用现有版本门禁）。

## 8. 验收标准

1. 侧边栏页面默认展示驾驶舱，无旧看板入口。
2. 「版本发布」区只显示就绪未发布版本；点击可跳转 ClickUp。
3. 流水线各状态数量与实际编排库一致。
4. 版本进度条、就绪数、状态徽标正确。
5. 实时活动显示最近 20 条记录。
6. 点击条目可打开详情抽屉，展示摘要/验收标准/PR/证据/时间线。
7. 编排状态变化后页面自动刷新（≤ 30 秒）。

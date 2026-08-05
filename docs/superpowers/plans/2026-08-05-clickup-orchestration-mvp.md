# ClickUp 编排 MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan phase-by-phase. Each phase requires its own approved detailed plan before code changes.

日期：2026-08-05
状态：待用户批准后进入实施
项目：王之强（狗哥）／365生活口语
代码基础：`gityuantao/365wefun-dashi-taskboard` Fork

## Goal

在 ClickUp 中建立任务／版本，系统自动完成「分析 → 开发 → 自动验证 → 建 PR → 部署测试环境 → 人工测试门禁 → AI 验收 → 版本聚合 → 最小 Web 发布」的完整闭环；状态、评论、证据全部回写 ClickUp，人员只在 ClickUp 操作。

MVP 验收演示路径（必须在实施结束后向用户演示）：

```text
ClickUp 新建任务 + 标记「自动化纳管」
→ 系统自动进入分析中（AI 产出范围与验收标准）
→ 自动进入开发中（Worktree/分支 → Codex 开发 → 自动验证 → PR → 测试部署）
→ 人工在 ClickUp 点「测试通过」→ 待验收
→ AI 按验收标准核验 → 待发布
→ 多个任务聚合进版本 → 版本待发布
→ 人工点「确认发布」→ 最小 Web 发布 → 版本已发布 / 任务批量已发布
```

## Architecture（MVP 版）

保留最终设计的三层骨架，但裁剪到最小闭环：

- **ClickUp**：业务状态与操作请求的唯一事实源（MVP 用定时轮询，不做 Webhook）。
- **Cloudflare Worker + D1**：云端控制面。轮询 ClickUp、快照比对、命令处理、Outbox 回写、作业队列、事件账本。
- **Mac 本地 Companion**：执行面。出站轮询作业 API、领取作业、执行 Worktree／Codex、回传结果信封。单 Mac、单用户，逻辑区分测试与正式。
- **Git／GitHub**：任务分支 → PR → 版本集成分支，验收通过后系统合入。
- **Web 发布**：MVP 只做 Web 一个部署单元（不可变目录 + 入口切换 + 健康检查）。

## Tech Stack

Node.js 22.5+、原生 ESM、React 19（控制台保持现有底座）、Cloudflare Workers/D1、Miniflare、`node:test`、Codex CLI（本地执行器）、ClickUp REST API。

## Global Constraints（MVP 版）

- 所有状态推进只能通过命令处理器，不能导出通用 `setStatus()`；重复命令幂等。
- 不修改线上 ClickUp、Cloudflare、GitHub、服务器或商店，除非当前阶段获得用户新鲜、明确授权；开发期一律使用 Sandbox List／测试任务。
- 只有标记「自动化纳管」的任务才会被自动分析／开发／验收；未纳管任务只记录不执行。
- 人工测试门禁（测试通过／不通过）与正式发布确认（确认发布）必须由人在 ClickUp 操作；AI 不得替代。
- ClickUp 内容、评论、附件一律视为不可信输入，防止提示词注入。
- 凭据（ClickUp API Token 等）只存环境变量或本地 Keychain，不进入代码、Git、D1、普通日志。
- 失败时停在原地：不推进状态、原因写回 ClickUp、可人工介入；返工轮次上限后阻塞。
- 每个任务使用独立 Worktree／分支；自动化不操作人员 `dev` 工作区。
- 遵守仓库 `AGENTS.md`：每一阶段先证明真实操作路径，再实现主路径，再向用户演示。
- MVP 明确不做：Webhook 与 7 层对账、Auth0／Passkey／Cloudflare Access、双 Runner 隔离、七平台适配器、数据库迁移体系、平台台账／告警、跨云备份、预算全量、多 Agent 开发、提示词治理。

## ClickUp 配置基线（M2 前的人工前置）

依据最终设计第 15.1 节，正式配置前在 Sandbox 验证：

| 对象 | 必须变更 |
|---|---|
| Sandbox `任务` List | 新增主状态 `验收中`；核验现有状态与 `目标版本` 关系 |
| Sandbox `版本` List | 新增主状态 `发布中`、`发布失败` |
| 任务字段（最小集） | 新增或核验 `自动化纳管`、`操作请求`、`操作请求ID`、`执行摘要`、`证据链接` |
| 版本字段（最小集） | 新增或核验 `操作请求`、`操作请求ID`、`Release Commit`、`Manifest摘要`、`发布尝试ID` |

所有 ID 按 ClickUp 稳定 ID 记录，不在代码中依赖中文名称。

---

## Phase M1：领域内核（全量执行 Phase 01 计划）

**准入依赖：** 最终设计已批准（已完成）。

MVP 唯一不打折的阶段。完整执行 `docs/superpowers/plans/2026-08-04-clickup-orchestration-phase-01-domain-foundation.md` 的全部 7 个任务：

- Task 1：Characterize Existing Cloud Path
- Task 2：Define Task and Version State Machines
- Task 3：Define Domain Errors, Commands, and Events
- Task 4：Add the Orchestration D1 Schema
- Task 5：Implement Event Store and Projection Repository
- Task 6：Implement the Pure Command Dispatcher
- Task 7：Add a Local-Only Diagnostic API Slice

**退出证据：** `npm run check` 通过；Miniflare 演示 `POST 命令 → 命令／事件／聚合行 → GET 结果`；现有 taskboard 云路径不变。

---

## Phase M2：ClickUp 配置注册表与 API 客户端

**准入依赖：** M1 完成；Sandbox 配置基线人工变更完成。

### Task M2-1: ClickUp 配置注册表

**Files:**
- Create: `orchestration/clickup/config-registry.mjs`
- Create: `orchestration/clickup/config.example.json`
- Create: `test/orchestration/clickup-config-registry.test.mjs`

**Interfaces:**
- Produces: `loadClickUpConfig()`, `resolveTaskStatus(name)`, `resolveVersionStatus(name)`, `fieldId(name)`。
- 内容：Workspace、Space、任务 List ID（正式基线 `901616282651`，Sandbox 使用独立 List 并记录其 ID）、版本 List ID（正式基线 `901616282740`，Sandbox 同理）、ClickUp 状态名 → 内部规范状态显式映射、自定义字段 ID 映射、Webhook/集成身份占位。
- 不保存任何密钥；`CLICKUP_API_TOKEN` 只来自环境变量。

- [ ] **Step 1: 写配置解析与状态映射测试（显式映射表，未知状态抛稳定错误码）**
- [ ] **Step 2: 运行并验证失败（module-not-found）**
- [ ] **Step 3: 实现最小注册表：JSON 配置 + 状态映射 + 字段映射**
- [ ] **Step 4: 运行聚焦测试；再跑 M1 全部测试确认无回归**
- [ ] **Step 5: 提交**

### Task M2-2: ClickUp REST 客户端

**Files:**
- Create: `orchestration/clickup/client.mjs`
- Create: `test/orchestration/clickup-client.test.mjs`（mock `fetch`，不依赖真实网络）

**Interfaces:**
- Produces: `getTask(id)`, `getTasksByList(listId)`, `getVersion(id)`, `getVersionsByList(listId)`, `updateTaskStatus(taskId, statusName)`, `updateCustomField(taskId, fieldId, value)`, `postComment(taskId, body)`, `getComments(taskId)`。
- 最小重试：仅对 429／5xx 指数退避最多 3 次；超时 30 秒；Token 从环境读取。

- [ ] **Step 1: 写失败测试：mock 响应归一化、重试、错误码映射**
- [ ] **Step 2: 运行并验证失败**
- [ ] **Step 3: 实现客户端（只读接口先实现：getTask/getTasksByList/getVersion/getVersionsByList/getComments）**
- [ ] **Step 4: 实现写接口（updateTaskStatus/updateCustomField/postComment），全部经 Outbox 调用（M3-2 后接线）**
- [ ] **Step 5: 运行聚焦测试与全量编排测试**
- [ ] **Step 6: 提交**

### Task M2-3: 快照归一化与持久化

**Files:**
- Create: `orchestration/clickup/snapshot.mjs`
- Modify: `cloud/migrations/0002_orchestration_core.sql`（新增 `clickup_snapshots` 表，或单独 `0003_clickup_snapshots.sql`）
- Create: `test/orchestration/clickup-snapshot.test.mjs`

**Interfaces:**
- Produces: `normalizeTask(payload)`, `normalizeVersion(payload)`, `saveSnapshot(db, object)`, `loadLastConfirmed(db, type, id)`, `compareSnapshots(confirmed, current)`。
- 快照保存：对象、List、状态、关键字段（自动化纳管、操作请求、目标版本、负责人、版本号）、字段哈希、读取时间。

- [ ] **Step 1: 写失败测试：状态映射、字段哈希、快照差异检测**
- [ ] **Step 2: 运行并验证失败**
- [ ] **Step 3: 实现归一化与快照仓库（prepared statements）**
- [ ] **Step 4: 运行聚焦测试与 M1 全量测试**
- [ ] **Step 5: 提交**

---

## Phase M3：云端控制面（Worker 轮询、Outbox、作业队列）

**准入依赖：** M2 完成。

### Task M3-1: ClickUp 轮询器

**Files:**
- Create: `cloud/src/clickup-poller.mjs`
- Modify: `cloud/src/index.mjs`
- Create: `test/orchestration/clickup-poller.test.mjs`（使用 `cloud-worker-harness`）

**Interfaces:**
- Produces: `pollClickUpOnce(env, {now}) -> {processed, commands}`。
- 行为：读取任务／版本 List → 归一化 → 与已确认快照比对 → 差异对象进入命令决策；只有 `自动化纳管=true` 的任务参与自动流程；操作请求字段（MVP 枚举：`测试通过`、`测试不通过`、`确认发布`、`撤回发布`、`取消`、`纳入自动化`）转为对应命令。
- 幂等：同一对象同一状态版本重复轮询不重复产生命令。

- [ ] **Step 1: 写失败测试：纳管开关、操作请求转命令、幂等**
- [ ] **Step 2: 运行并验证失败**
- [ ] **Step 3: 实现最小轮询器（无 Webhook、无 7 层对账）**
- [ ] **Step 4: 接入现有 Worker 路由（本地 Miniflare 运行，不部署）**
- [ ] **Step 5: 运行聚焦测试与全量测试**
- [ ] **Step 6: 提交**

### Task M3-2: Outbox 回写（最小防循环）

**Files:**
- Create: `orchestration/clickup/outbox.mjs`
- Modify: D1 迁移（新增 `outbox_mutations` 表）
- Create: `test/orchestration/clickup-outbox.test.mjs`

**Interfaces:**
- Produces: `enqueueMutation(db, {mutationId, object, field, expectedBefore, target})`, `flushOutbox(db, client)`, `confirmMutation(db, mutationId)`。
- 防循环：只匹配「对象 + 字段 + 期望前值 + 目标值 + 系统身份 + 有效时间窗」的系统回写；mutation 过期后不把后续人工修改误认成系统回写。

- [ ] **Step 1: 写失败测试：防循环、过期误认、幂等**
- [ ] **Step 2: 运行并验证失败**
- [ ] **Step 3: 实现 Outbox（所有 ClickUp 写操作经它）**
- [ ] **Step 4: 接入 M2-2 的写接口与 M3-1 轮询器**
- [ ] **Step 5: 运行聚焦测试与全量测试**
- [ ] **Step 6: 提交**

### Task M3-3: 作业队列与领取 API

**Files:**
- Create: `cloud/src/runner-routes.mjs`
- Modify: `cloud/src/index.mjs`
- Modify: D1 迁移（新增 `runner_jobs` 表）
- Create: `test/orchestration/runner-jobs.test.mjs`

**Interfaces:**
- Produces: `enqueueJob(db, {jobId, commandId, jobType, payloadHash, expiresAt})`, `claimJob(db, {deviceId, jobType})`, `completeJob(db, {jobId, deviceId, result})`。
- 路由：`GET /api/runner/jobs/next`（领取）、`POST /api/runner/jobs/:id/result`（回传）。
- 租约最小版：领取写入设备 ID + 执行代次 + 过期时间；过期后其他设备可重新领取；结果信封校验 jobId + 设备 ID。

- [ ] **Step 1: 写失败测试：领取唯一性、过期重领、结果必须匹配领取者**
- [ ] **Step 2: 运行并验证失败**
- [ ] **Step 3: 实现作业表与路由（本地 Miniflare）**
- [ ] **Step 4: 运行聚焦测试与全量测试**
- [ ] **Step 5: 提交**

---

## Phase M4：本地 Runner 最小执行面

**准入依赖：** M3 完成。

### Task M4-1: Companion 主循环

**Files:**
- Create: `orchestration/runner/companion.mjs`
- Create: `scripts/companion.mjs`
- Create: `test/orchestration/companion.test.mjs`

**Interfaces:**
- Produces: `runCompanion({apiUrl, deviceId})` 主循环：注册/心跳 → 轮询 `GET /api/runner/jobs/next` → 领取 → 按 `jobType` 分发到执行器 → `POST /api/runner/jobs/:id/result`。
- 失败处理：执行器异常 → 回传 `{status: "failed", reason, evidence}`，任务停在原地。

- [ ] **Step 1: 写失败测试：领取-执行-回传、失败回传、心跳**
- [ ] **Step 2: 运行并验证失败**
- [ ] **Step 3: 实现 Companion 主循环与 `npm run companion` 脚本**
- [ ] **Step 4: 本地 Miniflare 联调领取与回传**
- [ ] **Step 5: 运行聚焦测试**
- [ ] **Step 6: 提交**

### Task M4-2: Worktree 执行器

**Files:**
- Create: `orchestration/runner/worktree.mjs`
- Create: `test/orchestration/worktree-runner.test.mjs`

**Interfaces:**
- Produces: `createTaskWorktree(repoPath, taskId)`, `runInWorktree(worktreePath, args)`, `assertClean(worktreePath)`。
- 每个任务独立 Worktree；路径只使用规范化 ID；清理前校验路径与 Git 状态；不操作人员 `dev` 工作区。

- [ ] **Step 1: 写失败测试：独立目录、路径校验、清理前检查**
- [ ] **Step 2: 运行并验证失败**
- [ ] **Step 3: 实现 Worktree 管理**
- [ ] **Step 4: 运行聚焦测试**
- [ ] **Step 5: 提交**

### Task M4-3: Codex 调用包装器

**Files:**
- Create: `orchestration/runner/codex-runner.mjs`
- Create: `test/orchestration/codex-runner.test.mjs`

**Interfaces:**
- Produces: `runCodex({workdir, prompt, skillPath, timeoutMinutes}) -> {exitCode, output, artifacts}`。
- MVP 最小：调用本地 Codex CLI（`codex exec`），注入任务描述、验收标准与硬约束（只写当前 Worktree、不推进 ClickUp 状态、不读取凭据）；输出与产物收集。

- [ ] **Step 1: 写失败测试：参数校验、超时、非零退出码**
- [ ] **Step 2: 运行并验证失败**
- [ ] **Step 3: 实现 Codex 包装器**
- [ ] **Step 4: 与 M4-2 联调一条本地开发路径**
- [ ] **Step 5: 运行聚焦测试**
- [ ] **Step 6: 提交**

---

## Phase M5：AI 执行器闭环

**准入依赖：** M4 完成。

### Task M5-1: 分析作业执行器

**Files:**
- Create: `orchestration/ai/prompts.mjs`
- Create: `orchestration/ai/analyzer.mjs`
- Create: `test/orchestration/analyzer.test.mjs`

**Interfaces:**
- Produces: `executeAnalysis(job, {client, db, codex})`。
- 行为：组装输入包（任务快照、范围要求、验收标准模板）→ Codex 只读分析 → 解析结构化输出（`scope`、`acceptance_criteria`（稳定 ID + 前置 + 操作 + 预期 + 证据要求）、`risks`、`open_questions`）→ 校验 → 回写 ClickUp 评论 + `执行摘要` 字段 → 完成命令（`analysis_completed` → 待开发）。
- 结论：`ready_for_development` / `needs_human` / `blocked`；`needs_human` 创建阻塞项，不推进。

- [ ] **Step 1: 写失败测试：结构化输出校验、结论枚举、needs_human 不推进**
- [ ] **Step 2: 运行并验证失败**
- [ ] **Step 3: 实现分析器**
- [ ] **Step 4: 与作业队列联调（分析作业端到端）**
- [ ] **Step 5: 运行聚焦测试**
- [ ] **Step 6: 提交**

### Task M5-2: 开发作业执行器

**Files:**
- Create: `orchestration/ai/developer.mjs`
- Create: `test/orchestration/developer.test.mjs`

**Interfaces:**
- Produces: `executeDevelopment(job, {client, db, codex, git})`。
- 行为：建 Worktree／分支（基线为版本分支或 main）→ Codex 开发 + 自动测试/构建 → 校验结果 → 创建 PR（目标版本分支，标题/描述含任务、范围、测试、风险）→ 最小 Web 测试部署 → 证据（PR 链接、测试输出、部署 URL）→ 完成命令（`development_completed` → 待测试）。
- 失败：回传 `failed` + 原因；不改范围、不强推、不跳过测试。

- [ ] **Step 1: 写失败测试：PR 创建、证据完整性、失败不推进**
- [ ] **Step 2: 运行并验证失败**
- [ ] **Step 3: 实现开发器**
- [ ] **Step 4: 端到端联调：分析完成 → 开发作业 → PR**
- [ ] **Step 5: 运行聚焦测试**
- [ ] **Step 6: 提交**

### Task M5-3: 人工测试门禁

**Files:**
- Create: `orchestration/application/test-gate.mjs`
- Create: `test/orchestration/test-gate.test.mjs`

**Interfaces:**
- Produces: `handleTestDecision(command, {client, db})`。
- 行为：ClickUp 操作请求 `测试通过` → `test_passed`（→ 待验收）；`测试不通过` → `test_failed`（→ 待开发，证据必填，返工轮次 +1）；角色校验（MVP：ClickUp 用户 → 本地角色映射表）。

- [ ] **Step 1: 写失败测试：通过/不通过路径、证据必填、返工累计**
- [ ] **Step 2: 运行并验证失败**
- [ ] **Step 3: 实现门禁**
- [ ] **Step 4: 与轮询器操作请求接线**
- [ ] **Step 5: 运行聚焦测试**
- [ ] **Step 6: 提交**

### Task M5-4: 验收作业执行器

**Files:**
- Create: `orchestration/ai/acceptance.mjs`
- Create: `test/orchestration/acceptance.test.mjs`

**Interfaces:**
- Produces: `executeAcceptance(job, {client, db, codex})`。
- 行为：按冻结验收标准逐条核验（代码、测试证据、部署、Commit）→ `accepted` → 待发布（必须已关联唯一目标版本）；`rejected` → 待开发 + 返工轮次 + 1；验收器只读，不能修复后自行通过。

- [ ] **Step 1: 写失败测试：逐条核验、无版本不推进、拒绝路径**
- [ ] **Step 2: 运行并验证失败**
- [ ] **Step 3: 实现验收器**
- [ ] **Step 4: 端到端联调：测试通过 → 验收作业**
- [ ] **Step 5: 运行聚焦测试**
- [ ] **Step 6: 提交**

### Task M5-5: 失败处理与返工预算

**Files:**
- Create: `orchestration/application/failure-handler.mjs`
- Modify: D1 迁移（新增最小 `blockers` 表）
- Create: `test/orchestration/failure-handler.test.mjs`

**Interfaces:**
- Produces: `recordFailure({db, aggregate, reason, evidence})`, `checkReworkBudget({db, taskId})`。
- 行为：任何执行失败 → 任务保持原状态 + 原因写回 ClickUp 评论 + 阻塞标记；返工轮次 ≥ 3 → 阻塞等待人工；人工通过操作请求 `取消` 或解除阻塞介入。

- [ ] **Step 1: 写失败测试：停在原地、原因回写、预算上限阻塞**
- [ ] **Step 2: 运行并验证失败**
- [ ] **Step 3: 实现失败处理器**
- [ ] **Step 4: 接入全部执行器**
- [ ] **Step 5: 运行聚焦测试与全量测试**
- [ ] **Step 6: 提交**

---

## Phase M6：版本聚合与最小 Web 发布

**准入依赖：** M5 完成；**先确认 365wefun Web 实际部署方式（OSS/ESA 还是服务器 + Nginx），决定 M6-3 适配器实现细节。**

### Task M6-1: 版本聚合器与最小 Manifest

**Files:**
- Create: `orchestration/release/version-aggregator.mjs`
- Create: `orchestration/release/manifest.mjs`
- Create: `test/orchestration/version-aggregator.test.mjs`

**Interfaces:**
- Produces: `checkVersionGate(db, versionId)`, `freezeManifest(db, versionId)`, `loadManifest(db, versionId)`。
- 门禁：至少一个有效任务；全部未取消关联任务均为 `ready_for_release`；无阻塞；每任务有验收报告、PR 且已合入版本分支；版本字段完整。
- Manifest 最小字段：版本号、任务 ID 集合、PR/Commit、验收证据引用、生成时间、校验和。

- [ ] **Step 1: 写失败测试：门禁逐条、Manifest 原子冻结**
- [ ] **Step 2: 运行并验证失败**
- [ ] **Step 3: 实现聚合器与 Manifest**
- [ ] **Step 4: 运行聚焦测试**
- [ ] **Step 5: 提交**

### Task M6-2: PR 合入版本分支

**Files:**
- Create: `orchestration/git/merge.mjs`
- Create: `test/orchestration/git-merge.test.mjs`

**Interfaces:**
- Produces: `mergeTaskPrToVersionBranch({repoPath, versionBranch, prRef})`。
- 行为：验收通过后系统合入（保留来源历史的 Merge Commit，不 squash）；合入后重新跑测试；冲突 → 任务退回待开发并生成冲突报告，不自动选边。

- [ ] **Step 1: 写失败测试：合入保留历史、冲突退回**
- [ ] **Step 2: 运行并验证失败**
- [ ] **Step 3: 实现合入器**
- [ ] **Step 4: 接入验收完成路径**
- [ ] **Step 5: 运行聚焦测试**
- [ ] **Step 6: 提交**

### Task M6-3: 最小 Web 发布适配器

**Files:**
- Create: `orchestration/release/adapters/web.mjs`
- Create: `test/orchestration/web-adapter.test.mjs`

**Interfaces:**
- Produces: `preflight()`, `uploadArtifact({versionId, digest})`, `switchEntry({versionId})`, `healthCheck()`, `collectEvidence()`。
- 行为：构建产物上传到不可变目录 `releases/<versionId>/<digest>` → 入口最后切换（短缓存）→ 健康检查 → 证据（URL、digest、时间）。
- **前置依赖：确认实际部署方式后按真实链路实现；未确认前该任务保持阻塞。**

- [ ] **Step 1: 确认 Web 部署方式（用户确认，外部事实）**
- [ ] **Step 2: 写失败测试（按真实链路）**
- [ ] **Step 3: 实现适配器（Mock 模式先行，真实凭据后接）**
- [ ] **Step 4: 运行聚焦测试**
- [ ] **Step 5: 提交**

### Task M6-4: 发布命令流

**Files:**
- Create: `orchestration/application/release-commands.mjs`
- Create: `test/orchestration/release-commands.test.mjs`

**Interfaces:**
- Produces: `handleConfirmRelease(command, {client, db})`, `handleReleaseResult(...)`。
- 行为：人工 `确认发布` → 版本 `releasing` → 执行 Web 适配器 → 成功 → 版本 `published` + 关联任务批量 `published`；失败 → 版本 `release_failed` + 原因回写，任务保持 `ready_for_release`。

- [ ] **Step 1: 写失败测试：确认→发布→批量完成；失败保留部分成功事实**
- [ ] **Step 2: 运行并验证失败**
- [ ] **Step 3: 实现发布命令流**
- [ ] **Step 4: 与 M6-3 接线**
- [ ] **Step 5: 运行聚焦测试与全量测试**
- [ ] **Step 6: 提交**

---

## Phase M7：端到端验收

**准入依赖：** M6 完成。

### Task M7-1: Sandbox 端到端演示

**Files:**
- Create: `test/orchestration/mvp-e2e.test.mjs`
- Create: `scripts/mvp-demo.mjs`（一键演示脚本：准备 Sandbox 任务 → 触发轮询 → 展示每一步状态）

- [ ] **Step 1: 写端到端测试：完整成功路径（建任务 → 纳管 → 分析 → 开发 → 人工测试通过 → 验收 → 版本聚合 → 确认发布 → 已发布）**
- [ ] **Step 2: 写端到端测试：失败路径（测试不通过 → 返工；开发失败 → 阻塞 + 原因回写）**
- [ ] **Step 3: 运行全部测试与 `npm run check`**
- [ ] **Step 4: 用 Sandbox List 向用户演示完整路径，收集确认**
- [ ] **Step 5: 记录演示证据（截图/评论链接/状态历史）**

### Task M7-2: MVP 交付清单

- [ ] 任务/版本状态机 + 命令 + 事件账本全部有测试（M1）
- [ ] 轮询器只处理纳管任务，操作请求转命令（M2/M3）
- [ ] 所有 ClickUp 写操作经 Outbox（M3）
- [ ] Companion 领取-执行-回传闭环可运行（M4）
- [ ] 分析/开发/验收执行器 + 人工测试门禁 + 失败处理全部接通（M5）
- [ ] 版本聚合 + 最小 Manifest + Web 发布 + 批量完成（M6）
- [ ] 用户现场确认 MVP 演示路径

---

## MVP 验收标准

1. 在 ClickUp Sandbox 新建任务并标记 `自动化纳管` 后，任务自动走完 `收件箱 → 分析中 → 待开发 → 开发中 → 待测试`。
2. 人工在 ClickUp 点 `测试通过` 后进入 `待验收`；AI 验收通过后进入 `待发布`。
3. 多个任务聚合进版本，版本门禁通过后生成最小 Manifest 并进入 `待发布`。
4. 人工点 `确认发布` 后，Web 测试/正式入口完成切换与健康检查，版本进入 `已发布`，关联任务批量 `已发布`。
5. 任意失败（开发失败、测试不通过、验收不通过）都停在原地：状态不推进、原因写回 ClickUp、返工轮次累计，超限后阻塞。
6. 未标记纳管的任务不会被自动处理。
7. `npm run check` 通过；所有状态推进均有命令与审计事件可查。

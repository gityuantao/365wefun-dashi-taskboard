# Development Orchestrator Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复开发结果分类和 staging 临时资源冲突状态流转，使正常任务持续推进且不再错误退回。

**Architecture:** 保留现有 task aggregate 和 runner job 基础设施，在开发执行边界增加小型结果分类器，在 staging lease 边界识别 `resource_busy`。不新增调度系统，不修改发布逻辑。

**Tech Stack:** Node.js ESM、Cloudflare D1/SQLite test harness、`node:test`。

## Global Constraints

- 全程不得真实写 ClickUp、创建 GitHub PR、部署、SSH、运行生产迁移或上传平台。
- 不读取、修改、删除或提交 `.data`。
- 保持 changed 开发和正常 staging 主路径兼容。
- 只修复已由 v1.0.4 真实案例证明的故障。

---

### Task 1: Development Result Classification

**Files:**
- Modify: `orchestration/ai/prompts.mjs`
- Modify: `orchestration/ai/developer.mjs`
- Test: `test/orchestration/developer.test.mjs`

**Interfaces:**
- Consumes: Codex `{exitCode, stdout, stderr}`。
- Produces: `changed | already_satisfied | needs_info | product_failure | orchestrator_infrastructure` 分类。

- [ ] 增加失败测试：已有修复结果不会进入 `waiting_info`，也不会调用 `commitAll`。
- [ ] 增加失败测试：无具体业务问题的“无法复现”结果不能触发 `needs_info`。
- [ ] 增加失败测试：真实具体业务问题仍进入 `waiting_info`，评论直接使用问题文本且不包含“静音文件名”。
- [ ] 修改 prompt，明确四种业务结果和 `needs_info` 的严格条件。
- [ ] 修改执行器，校验结构化结果并实现最小状态流转。
- [ ] 运行 `node --test test/orchestration/developer.test.mjs`。

### Task 2: Infrastructure Failure Preservation

**Files:**
- Modify: `orchestration/ai/developer.mjs`
- Modify: `orchestration/runner/tick-recovery.mjs`（仅当现有重试契约需要分类输入）
- Test: `test/orchestration/developer.test.mjs`
- Test: `test/orchestration/tick-recovery.test.mjs`

**Interfaces:**
- Produces: `{status:'failed', classification:'orchestrator_infrastructure', retryable:true}`，任务保持 `developing`。

- [ ] 增加失败测试：Codex 非零退出和无效 JSON 不产生 `development_failed`。
- [ ] 增加失败测试：worktree、commit 或 PR 故障保持开发状态并返回可重试分类。
- [ ] 删除执行基础设施故障对 `rollbackDevelopment` 的调用；只在结构化 `product_failure` 使用产品回退。
- [ ] 复用现有 runner retry 上限；验证不会形成无限紧循环。
- [ ] 运行 developer 与 tick recovery 聚焦测试。

### Task 3: Staging Resource Queue

**Files:**
- Modify: `orchestration/application/staging-coordinator.mjs`
- Test: `test/orchestration/staging-coordinator.test.mjs`

**Interfaces:**
- Produces: `{status:'failed', classification:'resource_busy', retryable:true, stage:'staging_lease'}`，aggregate 保持 `accepting`。

- [ ] 增加失败测试：共享 staging lease 被占用时不执行 `acceptance_rejected`，不发布“验收不通过”评论。
- [ ] 在 lease acquisition 抛出 typed `resource_busy` 错误。
- [ ] 在 catch 边界为该分类持久化 attempt 证据并直接返回，不调用通用 `transitionFailure`。
- [ ] 验证 lease 释放后同一 Candidate 可再次执行正常 staging。
- [ ] 运行 staging coordinator 聚焦测试。

### Task 4: Regression and Audit

**Files:**
- Modify: `docs/开发记录.md`
- Modify: `.superpowers/sdd/2026-08-12-development-orchestrator-recovery/progress.md`

- [ ] 运行 developer、tick recovery、staging coordinator、failure handler、poller、orchestrator lifecycle 聚焦套件。
- [ ] 运行 `pnpm test:orchestration`，记录通过数和任何基线失败。
- [ ] 运行 `git diff --check` 和项目结构校验。
- [ ] 审计所有新分类对应的任务状态、评论、retryable 标志及零外部副作用。
- [ ] 提交实现与报告。

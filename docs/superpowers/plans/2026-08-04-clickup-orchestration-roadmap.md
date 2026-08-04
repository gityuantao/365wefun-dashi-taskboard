# ClickUp AI Orchestration Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this roadmap phase-by-phase. Each phase requires its own approved detailed plan before code changes.

**Goal:** 将现有 dashi-taskboard 演进为 ClickUp 驱动、测试与正式隔离、支持 AI 研发和七部署单元自动发布的编排系统。

**Architecture:** 保留现有 React、Node.js ESM、Cloudflare Worker/D1/R2 和本地 Companion，但把业务状态机、命令、事件账本、集成适配器与执行 Runner 拆成明确模块。ClickUp 是业务事实源，Cloudflare Workflows 是流程事实源，GitHub和各发布平台保留专业事实；普通 Taskboard UI 只读。

**Tech Stack:** Node.js 22.5+、原生 ESM、React 19、Vite 8、Cloudflare Workers/Workflows/D1/R2、Miniflare、`node:test`、Auth0、Cloudflare Access、macOS Runner。

## Global Constraints

- 正式和测试使用独立 Cloudflare 账户、Auth0 Tenant、OAuth身份、Webhook、D1、R2、Secrets和Runner身份。
- 同一Mac双用户只能达到 `受限生产就绪`；完整生产隔离要求独立正式主机或虚拟机。
- 正式Runner不执行AI自由文本命令，只执行签名作业信封指定的已注册适配器。
- 正式发布、原样重试、生产锁转移和高风险操作要求两名不同稳定主体审批。
- ClickUp、附件、评论、平台文本和AI输出全部视为不可信输入。
- L3数据禁止进入AI、ClickUp、Git、D1、R2和普通日志。
- 所有生产副作用先持久化命令与审计事件，再执行外部动作。
- 不修改线上ClickUp、Cloudflare、GitHub、服务器或商店，除非当前执行阶段获得用户新鲜、明确授权。
- 每一阶段先证明真实操作路径，再实现主路径，再向用户演示；遵守仓库 `AGENTS.md`。

---

## Phase Map

| 阶段 | 独立交付物 | 准入依赖 | 退出证据 |
|---|---|---|---|
| 01 领域内核与审计基础 | 状态机、命令信封、追加事件、D1投影骨架 | 最终设计已批准 | 单元／模型／迁移测试通过 |
| 02 ClickUp影子集成 | 配置注册表、Webhook Inbox、快照归一化、Outbox、对账 | 01 | 7天只读影子报告，无副作用 |
| 03 身份、授权与紧急控制 | Auth0/Access、角色、双签、只读控制台、暂停／撤权 | 01–02 | 越权与职责分离安全测试通过 |
| 04 Runner协议与Companion | 设备注册、签名作业、租约、结果信封、双Runner隔离 | 01、03 | 克隆／重放／断线测试通过 |
| 05 AI任务生命周期 | 分析、开发、测试会话、AI验收、返工与阻塞 | 02、04 | Sandbox完成20任务流程 |
| 06 Git与版本集成 | Worktree、PR、版本分支、RC、Manifest、生产线锁 | 04–05 | 3个Sandbox版本及故障恢复通过 |
| 07 测试环境适配器 | 七部署单元Preview、数据隔离、证据、清理 | 04–06 | 每单元3次部署及清理通过 |
| 08 正式发布适配器 | Web/Admin、API/Worker、DB、iOS、Android OSS、小程序 | 03–07 | 每适配器Level 1–4认证 |
| 09 审核监控与运维 | 两层平台台账、轮询、整改任务、事故、macOS告警 | 02、08 | 故障注入和事故时限演练通过 |
| 10 备份迁移与灰度上线 | Time Travel、OSS增量／快照、ClickUp迁移、分阶段启用 | 01–09 | 恢复演练、四类验收、受控首发通过 |

## Plan Production Rule

- 每个阶段开始前，在本目录创建 `YYYY-MM-DD-clickup-orchestration-phase-NN-<name>.md`。
- 阶段计划必须引用前一阶段已经落地的真实文件、导出接口和测试命令，不得预先猜测行号。
- 阶段验收失败时先修复当前阶段，不并行开放后续权限。

# Development Orchestrator Recovery Design

## Goal

让正常开发任务持续推进，并准确区分业务信息缺失、无需新增改动、产品代码失败、编排器执行故障和测试环境临时占用。任何本地开发、测试和复核都不得写入 ClickUp 或触发部署。

## Proven Failure Path

1. `cloud/src/clickup-poller.mjs` 创建 develop 或 staging job。
2. `orchestration/ai/developer.mjs` 调用 Codex，并解析其结构化结果。
3. 当前 prompt 强制把“无法复现、线上正常、找不到可修点”输出为 `needs_info`；执行器随后把任务改成 `waiting_info`。
4. 当前执行器把 Codex 非零退出、无效 JSON 和缺少 `change_summary` 统一执行 `development_failed`，退回 `ready_for_development`。
5. 当前 staging coordinator 获取共享环境 lease 失败后执行 `acceptance_rejected`，因此“另一任务正在部署”在 ClickUp 中显示成验收不通过。

v1.0.4 已出现三个对应实例：已有连字符发音修复却被退回待补充信息；空状态任务收到与需求无关的“静音文件名”模板；视觉任务代码验收通过后因 staging lease 占用被标为验收不通过。

## Result Contract

开发器只返回以下业务结果：

- `changed`：产生与需求相关的代码改动，继续 commit、PR 和代码验收。
- `already_satisfied`：仓库当前代码已经满足需求，并提供精确代码及验证证据；不制造空提交，由原 Candidate/基线证据进入代码验收。
- `needs_info`：只有缺少无法从任务、仓库或既有评论推断的业务决定，且不同答案会显著改变实现或验收时允许使用。必须返回具体问题，不得使用通用示例模板。
- `product_failure`：确认存在产品代码或聚焦验证失败，但本轮没有形成可验收交付。保留诊断供有界自动重试，不把基础设施错误伪装成业务信息缺失。

Codex 进程失败、输出协议失败、工作树/Git/PR/ClickUp evidence 写入失败属于 `orchestrator_infrastructure`，不得改变任务业务状态。runner job 记录分类和可重试性，由现有 tick recovery 进行有界恢复。

## State Rules

- 只有明确、结构化且通过执行器校验的 `needs_info` 才从 `developing` 进入 `waiting_info`。
- `already_satisfied` 必须携带代码位置和实际验证证据；执行器将其记录为可验收结果，不要求空 PR。
- 可重试执行故障保持 `developing`，不得执行 `development_failed`。
- 真正产品开发失败可回到 `ready_for_development`，但必须标记 `product_failure`，并受现有返工预算约束。
- staging lease 冲突是 `resource_busy`：任务保持 `accepting`，本次 job 返回可重试结果，不创建 `acceptance_rejected` 事件，不消耗产品返工次数。
- 其他 staging 基础设施失败继续持久化证据，但不得描述为产品验收失败；本设计只直接修复已证实的临时资源冲突。

## Retry Policy

- runner job 的可重试故障使用现有 retry/recovery 基础设施，不新增第二套调度器。
- 相同 job 的尝试次数必须有上限；达到上限后保持可审计的 infrastructure failure，不转换成 `waiting_info` 或产品验收失败。
- staging `resource_busy` 由调度循环稍后重新创建/恢复 staging job；重复占用只更新内部尝试证据，不重复发布误导评论。

## Comments

- `needs_info` 评论只包含模型提出且执行器验证非空的具体问题。
- 禁止硬编码“静音文件名/复现方式/预期结果”等跨任务模板。
- infrastructure 评论明确“编排器执行暂时失败，将自动重试”，不要求用户修改需求或手工改状态。

## Verification

使用本地 fake ClickUp client、fake Codex、fake Git/staging adapter 和临时 D1：

1. 已有修复返回 `already_satisfied` 时不进入待补充信息，也不创建空 commit。
2. “无法复现”但没有具体业务问题时不能触发 `needs_info`。
3. Codex 非零退出、无效 JSON、Git/PR 错误不回退待开发。
4. 真实业务问题可进入待补充信息，评论不含无关模板。
5. staging lease 被占用时保持 `accepting`，返回 `resource_busy/retryable`，不生成验收拒绝事件。
6. 正常 changed 开发和正常 staging 路径保持通过。

## Non-goals

- 不修改 v1.0.4 的产品业务代码。
- 不改变发布流程或生产门禁。
- 不执行真实 ClickUp 写入、GitHub PR、部署、SSH、数据库迁移或平台上传。
- 不为未知假设扩展通用工作流引擎。

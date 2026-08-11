# 提测失败归属与防循环设计

**日期：** 2026-08-11  
**状态：** 已获用户设计批准

## 背景

任务 `86d3yebnh` 已完成产品开发和自动验收，但提测阶段连续三次因
`merged PR commit is not the current remote version branch` 失败。每次失败都被退回
产品开发流程；开发器虽然读取到了 ClickUp 最新评论，却只能操作产品仓库，无法修复
位于 taskboard 编排器中的错误校验，因此形成“开发完成 → 提测失败 → 再开发”的循环。

## 目标

1. 已合入版本分支的旧 PR 在版本分支继续前进后仍可作为有效提测来源。
2. 产品代码失败与编排器、合并、部署、TestFlight 基础设施失败由不同流程处理。
3. 相同基础设施失败不得反复触发产品开发。
4. 产品返工必须读取最新评论及图片，并证明上一轮产品失败原因已被处理。
5. 保持现有安全约束：不泄露凭据、不自动提交 App Review、不在条件未满足时进入待测试。

## 方案

### 1. Git 合入证明

对于状态为 `MERGED` 的 GitHub PR：

- 刷新远端版本分支到隔离 ref，不修改用户当前工作区。
- 校验 PR `headRefOid` 和 `mergeCommit.oid` 均为合法提交。
- 以 `git merge-base --is-ancestor <commit> <remote-version-ref>` 验证包含关系。
- merge commit 是当前远端版本分支的祖先时，使用远端版本分支最新 SHA 作为
  `candidateCommit`；不要求 merge commit 等于最新 SHA。
- PR 提交未被包含、远端刷新失败或提交不可解析时失败关闭，不进入部署。

这保证部署的是当前版本分支完整快照，同时证明目标任务确实已合入该快照。

### 2. 失败归属

提测失败生成结构化归属：

- `product_rework`：自动验收发现的代码、测试或验收标准问题。允许退回待开发，开发器必须读取最近 12 条评论及对应图片。
- `staging_infrastructure`：GitHub/远端分支证明、merge、部署命令、测试环境、TestFlight、ASC 回读或编排器配置问题。不得创建新的产品 develop job。
- `needs_info`：评论或图片不可读取、需求缺少不可推断信息。进入待补充信息。

现有 stage 错误中的 `merge`、`deploy`、`ios_*` 和 `comment` 阶段均归入
`staging_infrastructure`。未来新增阶段必须显式声明归属，未知阶段失败关闭并按
基础设施故障处理，不能默认派给产品开发。

### 3. 失败指纹与循环门禁

基础设施失败指纹由以下规范化字段组成：

`taskId + candidateCommit + stage + classification + redactedError`

- 首次失败：持久化失败证据并在 ClickUp 发布结构化评论。
- 相同 Candidate、阶段和脱敏错误再次出现：不得创建 develop job，也不得继续自动重试；
  评论明确标识“相同提测故障仍未解决”。
- Candidate 改变或错误指纹改变后，才允许再次执行对应提测阶段。
- 产品返工不使用基础设施失败计数消耗验收返工次数。

### 4. 状态转换

- 自动验收不通过：`验收不通过` 或按现有受控返工规则进入 `待开发`。
- 提测基础设施失败：任务保持可识别的非待测试状态，内部记录为
  `staging_blocked`；ClickUp 使用现有可用状态中的「验收不通过」，并在评论中明确
  “产品开发已完成，当前为提测基础设施故障”，避免误导为产品代码验收失败。
- 基础设施恢复后：从已验收的 Candidate 继续提测，不重新运行产品开发；全部平台部署及
  TestFlight 权威回读满足后才进入「待测试」。

### 5. 开发反馈闭环

只有 `product_rework` 才进入开发器。开发提示必须包含：

- 最近 12 条 ClickUp 评论，按时间倒序；
- 同一评论窗口内的可读取图片；
- 最新验收反馈字段；
- 上一轮产品失败的结构化阶段、原因和指纹。

开发结果必须说明如何处理上一轮产品失败，并提供对应验证项。若没有代码变化或验证项与
失败原因无关，则不得宣告返工完成。基础设施错误即使出现在评论中，也只作为上下文展示，
不能要求产品开发器通过同步分支来“修复”编排器。

## 测试要求

1. MERGED PR 的 merge commit 等于版本分支 HEAD 时通过。
2. MERGED PR 的 merge commit 是较早祖先、版本分支已有后续提交时通过，并以最新远端 SHA 为 Candidate。
3. PR head 或 merge commit 不在版本分支历史中时失败关闭。
4. merge/deploy/TestFlight 失败不创建 develop job。
5. 同一基础设施失败指纹重复时不重试、不消耗产品返工次数。
6. Candidate 或失败指纹改变后可恢复提测。
7. 产品验收失败仍能按现有规则返工，并保留最新评论、图片和验收反馈。
8. `86d3yebnh` 的历史 PR 场景作为回归夹具：旧 merge commit 已包含于当前
   `version/v1.0.3` 时不得报“不是当前远端版本分支”。

## 非目标

- 不修改 `365wefun` 产品功能。
- 不自动处理或绕过真实部署失败。
- 不降低 Web、双 iOS App/TestFlight 或 ASC 权威回读门禁。
- 不自动提交 App Review 或部署生产环境。


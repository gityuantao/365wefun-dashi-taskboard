# 任务进入待测试前的测试环境部署门禁设计

## 1. 目标

修正当前“代码自动验收通过即进入待测试”的错误语义。任务只有在开发结果合入目标版本分支、测试环境部署完成，并从测试环境回读到包含该任务提交的运行版本证据后，才能进入 ClickUp「待测试」。

本设计不新增 ClickUp 状态。合并、部署和回读期间，任务保持「开发中」。

## 2. 已证明的现状路径

当前真实路径为：

1. `orchestration/ai/developer.mjs` 在任务工作树提交改动并创建面向版本分支的 PR。
2. 开发完成事件把聚合状态推进到 `accepting`。
3. `orchestration/ai/acceptance.mjs` 只读检查目标 commit；结果为 accepted 时立即派发 `acceptance_passed`。
4. `orchestration/domain/task-state.mjs` 将 `accepting` 转为 `ready_for_test`。
5. 状态同步器将 ClickUp 改成「待测试」。

该路径没有合并 PR、部署测试环境或运行 SHA 回读。`86d3xmaw8` 的提交 `f18e0c2e` 和 PR #881 仍未合并时已进入「待测试」，证明缺口可复现。

### 2.1 已有能力与缺失接线

仓库历史中已经实现过三块相关基础能力：`3fc1fa4` 增加任务 PR 合入版本分支，`052ea1c` 增加 Web 发布适配器，后续 `114cf24`、`2119c0d`、`4d9ea9b` 增加部署 readback 与不可变 Candidate 校验。这些能力目前属于整版发布流程。

历史中不存在 `stage_task`、任务级 staging adapter 或“验收通过后部署测试环境”的作业链路；当前运行配置的 `releaseAdapterModule` 也为空。因此此前测试环境部署是人工或 Codex 单次执行后再手动推进状态，并非编排器自动完成。本设计复用已有合并/readback 思路，但新增任务级 staging 接线，不复制整版生产发布状态机。

## 3. 目标路径

目标路径固定为：

`开发完成 → 代码自动验收通过 → 合并任务 PR 到目标版本分支 → 串行部署该版本分支到测试环境 → 回读运行版本 → 待测试`

代码自动验收通过后不再直接派发 `acceptance_passed`，而是创建 `stage_task` Runner 作业。该作业完成全部外部副作用并获得证据后，才派发 `acceptance_passed`。

## 4. 组件边界

### 4.1 验收器

`orchestration/ai/acceptance.mjs` 仍只负责代码验收。accepted 结果写入验收作业结果，但任务聚合保持 `accepting`，随后幂等创建 `stage_task` 作业。

验收器不得直接合并、部署或改变 ClickUp 为「待测试」。

### 4.2 测试环境门禁协调器

新增任务级 staging 协调器，按以下顺序执行：

1. 从最近一次成功 develop 作业读取 PR URL、任务提交 SHA、版本分支和目标版本。
2. 确认 PR 仍指向预期版本分支且 head SHA 与验收提交一致。
3. 合并 PR；若已合并，则回读 merge commit 并继续，保证重试幂等。
4. 获取合并后的远端版本分支 SHA，作为本次 staging candidate。
5. 获取共享 staging 租约；同一时刻只允许一个部署作业修改测试环境。
6. 调用已配置的 staging adapter 部署 candidate。
7. 调用 adapter readback，从测试环境 `/version` 等权威端点取得 `releaseId`、`gitSha`、地址和部署时间。
8. 证明运行 SHA 等于 candidate，或运行 SHA 的 Git 历史包含任务提交 SHA。
9. 保存不可变部署证据，派发 `acceptance_passed`，再由既有状态同步改为「待测试」。

### 4.3 Staging adapter

新增与生产 release adapter 分离的 `stagingAdapterModule` 配置。接口固定为：

```js
{
  async deploy({ candidateCommit, versionBranch, taskId, targetVersion }) {
    return { releaseId, url, startedAt };
  },
  async readback({ deployment, candidateCommit }) {
    return { confirmed, releaseId, gitSha, urls, deployedAt };
  }
}
```

真实适配器封装现有上海测试环境发布动作，只读取既有私密配置，不把服务器凭据写入仓库、数据库、评论或日志。未配置适配器时必须失败关闭，任务保持「开发中」。

## 5. 状态与持久化

不改变 ClickUp 状态集合，也不新增对外状态。

- `accepting`：内部含义扩展为“代码验收及测试环境门禁进行中”；ClickUp 继续显示「开发中」。
- `ready_for_test`：唯一含义为“测试环境已部署且可验证”；ClickUp 显示「待测试」。

新增 `staging_deployments` 记录：task id、target version、PR、task commit、candidate commit、version branch、release id、observed git SHA、URLs、状态、attempt、错误、开始/完成时间。该表为重试、审计和 UI 证据来源。

共享租约使用固定资源键 `staging-environment`。获得租约后重新读取远端版本分支，以免等待期间部署过期 candidate。

## 6. 失败与恢复

- PR 不存在、目标分支不符或 head SHA 不符：作业失败，保持「开发中」，评论精确原因。
- PR 合并冲突或保护规则拒绝：作业失败，保持「开发中」，不强制绕过保护规则。
- 部署失败：保持「开发中」，记录部署阶段和错误；普通失败不自动无限重试。
- 回读缺少 `gitSha`、返回 `local`、SHA 不匹配或不包含任务提交：门禁失败，绝不进入「待测试」。
- 进程中断：过期租约回收后，新作业根据 PR 合并状态和已存证据从安全边界继续，不重复创建 PR。
- 人工把任务改为「待补充信息」、取消或发布：现有人工暂停/终态优先规则继续生效，staging 作业在下一副作用边界停止。

## 7. ClickUp 证据

成功后只发布一条结构化评论：

```text
✅ 测试环境已部署，进入待测试
任务提交：<task commit>
版本分支：<version branch>
运行版本：<observed git sha>
Release：<release id>
测试地址：<urls>
部署时间：<deployed at>
```

失败时发布“测试环境部署失败，任务保持开发中”，附非敏感阶段和摘要。不得使用原来的“开发完成（自动验收通过），进入待测试”文案冒充部署结果。

## 8. `86d3xmaw8` 修复处理

代码上线后，将 `86d3xmaw8` 从错误的 `ready_for_test/待测试` 恢复到可执行 staging 门禁的内部状态；复用现有 PR #881 和提交 `f18e0c2e`，不重新开发、不新建重复 PR。协调器随后合并、部署、回读；只有证据成立时重新进入「待测试」。

## 9. 验收条件

1. accepted 代码验收本身不能产生 `task.acceptance_passed` 或 ClickUp「待测试」。
2. 未配置 staging adapter、PR 未合并、部署失败、`gitSha=local` 或 SHA 不匹配时，任务始终保持「开发中」。
3. PR 合并、部署和回读全部成功后，恰好产生一次 `task.acceptance_passed`，并留下完整部署证据。
4. 两个任务同时通过代码验收时，测试环境部署严格串行；后部署任务不会让前一任务在证据不足时误判通过。
5. 重启或重试不会重复创建 PR、重复合并或重复推进状态。
6. `86d3xmaw8` 最终只有在测试环境运行版本包含 `f18e0c2e` 后才显示「待测试」。

## 10. 非目标

- 不发布生产环境。
- 不自动把整个版本标记为已发布。
- 不新增「待部署」ClickUp 状态。
- 不绕过 GitHub 分支保护或测试环境健康检查。
- 不把服务器密钥、环境变量或部署命令明文保存到代码仓库。

# 正式版本全自动发布设计

**日期：** 2026-08-11  
**状态：** 用户已确认规格内容

## 背景

Taskboard 已有版本发布按钮、版本状态机、版本门禁、冻结 Candidate、Manifest、失败重试、发布回读与发布后清理框架，但当前运行配置 `releaseAdapterModule` 为空。页面点击“发布”只能把 ClickUp 版本切换到「发布中」，无法执行真实生产发布。

本设计补齐正式版本发布的最后一公里：Web/API 自动生产部署，以及注册表内全部启用 iOS App 的构建、上传、提交 App Store 审核、审核通过后立即自动上架和线上回读。

## 已确认的业务决策

1. 点击发布后自动部署 Web/API 生产环境。
2. 所有 enabled iOS App 自动上传、提交 App Store 审核；审核通过后立即自动上架。
3. 所有必需平台全部成功后版本才进入「已发布」。
4. 已成功平台保持结果；失败重试只补偿未完成或失效的平台，不回滚已成功平台。
5. 本期支持 Web、API 与 iOS。版本涉及 Android 或小程序时失败关闭并提示未配置，禁止静默忽略。
6. 当前 iOS App 为海外版和中国版；未来新增国家 App 通过注册表自动进入发布门禁，不新增国家分支判断。

## 总体流程

1. 发布管理员在版本详情点击“发布版本”。
2. 页面展示版本、Candidate、任务、生产目标和全部 iOS App；管理员输入版本号二次确认。
3. 编排器检查版本门禁和平台支持范围。
4. 集成版本内任务 PR，采集回归证据和制品身份。
5. 将当前远端版本分支冻结为不可变 Candidate，并持久化 Manifest。
6. 部署 Web/API 生产环境，完成健康检查与 Candidate 权威回读。
7. 按 iOS App 注册表顺序逐个构建、上传并等待 Apple processing。
8. 为每个 App 提交 App Store Review，并设置审核通过后立即自动发布。
9. 编排器定时权威回读审核、上架和线上版本状态；等待期间版本保持「发布中」。
10. Web/API 与全部 iOS App 均确认线上版本后，版本和 Manifest 内任务进入「已发布」。
11. 关闭任务 PR、删除远端任务分支并清理本地任务 Worktree；清理失败独立补偿，不撤销发布结果。

## 版本门禁

发布开始前必须同时满足：

- 版本内至少有一个任务；
- 所有版本任务均为「待发布」；
- 没有开放阻塞项；
- 每个任务具有精确 PR、已验收提交和目标版本证据；
- Candidate SHA、远端不可变 Candidate ref、回归证据和制品身份完整；
- 版本影响平台可由任务平台字段完整汇总；
- 仅包含 Web、服务端和 iOS；出现 Android 或小程序即失败关闭；
- 每个 enabled iOS App 的 App ID、scheme、bundle ID、版本号、build 来源、审核/发布配置完整且为 own properties；
- 生产部署器、App Store Connect 凭据和必要命令均已配置，但配置值不得进入页面或持久化证据。

门禁失败时不得创建外部发布副作用，版本保持原状态并显示精确缺口。

## 架构与组件

### 发布协调器

扩展现有 `coordinateVersionRelease` 和 `coordinateReleaseSnapshot`，保持 Manifest 冻结、Candidate 验证、发布回读和清理职责。协调器只依赖确定性适配器，不调用 AI。

### 生产 Web/API 适配器

真实 `createReleaseAdapter` 模块必须提供：

- `collectRegressionEvidence`：收集冻结 Candidate 的完整回归结果；
- `identifyArtifact`：确定可复现的生产制品身份；
- `release`：执行生产预检、不可变上传、入口原子切换和健康检查；
- `readback`：从生产权威状态回读 Candidate SHA、制品身份、release ID、URL 和健康状态。

生产发布沿用不可变 release 目录。切换前失败不影响当前生产；切换或健康检查失败时记录失败，并确保旧生产入口仍可恢复或继续可用。

健康门禁至少覆盖公开 Web、管理后台、API ready、数据库和 Redis。回读 SHA 必须精确等于 Manifest Candidate。

### iOS App Store 发布适配器

iOS 发布复用现有 App 注册表和 TestFlight 身份规则，并扩展正式发布字段：

- App Store App ID；
- 审核提交配置；
- 自动发布模式；
- 审核/线上回读命令；
- 可选的国家、商店元数据与合规配置引用。

每个 enabled App 独立执行：自动化测试、Staging/Release 归档、安全扫描、上传、processing 回读、审核提交、审核状态回读、自动上架和线上版本回读。归档必须使用生产配置，禁止测试 API、Debug hook、模拟支付或测试 StoreKit 配置进入生产制品。

## 持久化模型

新增版本发布 attempt 与按平台/按 App 的发布记录，至少包含：

- `version_id`、`candidate_commit`、`manifest_checksum`；
- `platform`、`app_id`、`stage`、`status`、`attempt`；
- Web/API 的 release ID、制品身份、生产回读 SHA 和健康证据；
- iOS 的 App Store App ID、bundle ID、marketing version、build、upload ID、review submission ID；
- Apple processing、review、release 和 live-version 状态；
- `started_at`、`updated_at`、`completed_at`；
- 完整脱敏错误指纹、受限展示错误和失败分类；
- 外部请求幂等键与未知结果回读标记。

历史成功行不可原地改写。补偿重试创建新 attempt 或审计行，并引用既有成功证据。

## 状态与成功条件

- `active`：版本进行中，尚未开始发布。
- `releasing`：已冻结 Manifest，至少一个平台正在执行、等待审核或等待权威回读。
- `release_failed`：存在确定失败或配置缺口；Manifest 保持冻结。
- `published`：Web/API 和所有 required iOS App 均权威确认线上 Candidate/版本。

任何单平台成功都不能让版本提前进入 `published`。任务只能在版本整体发布成功后批量进入 `published`。

## 幂等、恢复与补偿

- 发布按钮使用版本 ID、Manifest checksum 和 Candidate 组成幂等请求标识；重复点击不创建重复发布。
- 外部动作前后使用租约和 fencing token；旧进程失去所有权后不能继续部署、上传或提交审核。
- Apple 审核等待期间只做权威 GET 回读，不重复上传或提交。
- 网络超时或未知提交结果必须先回读 App Store Connect/生产状态，再决定是否重试。
- `release_failed` 重试必须复用原冻结 Manifest 和 Candidate，只处理未成功或已失效的平台。
- 已上线 Web/API 或 iOS App 不因另一平台失败而自动回滚。
- App Store 被拒审时记录 App、阶段、审核状态与脱敏摘要；修复后生成新 build，仅补偿该 App。
- 清理步骤独立持久化并可重试；清理失败不改变 `published`。

## 权限与交互

- 只有 `release_manager` 或 `admin` 可发布。
- 发布确认弹窗显示版本号、Candidate SHA、任务数、生产目标，以及每个 iOS App 的名称、App ID、scheme、bundle ID 和版本号。
- 用户必须输入精确版本号才能确认。
- 警告文案明确说明：将部署生产、提交全部 iOS App 审核，并在审核通过后立即上架。
- 发布中页面展示 Web/API 与每个 App 的独立阶段、最近权威回读时间和失败摘要。
- 页面仅提供“重试失败步骤”，不提供跳过门禁、强制成功或直接改已发布。
- Master pause 停止新外部动作，但不撤销已提交给 Apple 的审核；恢复后继续回读。

## 安全

- ASC API key、issuer、private key、SSH/服务器凭据仅从权限受控私密文件或运行环境读取。
- 注册表和运行配置只能保存非秘密引用，不得保存私钥或 token。
- URL userinfo、Authorization、Cookie、JWT、裸密钥、签名输出和上传日志在进入 D1、日志、ClickUp、页面响应前统一脱敏。
- 发布命令仅通过允许列表传入必要环境变量；不得把完整父进程环境传给子进程。
- 页面和 API 不返回凭据是否存在之外的具体秘密信息。
- 所有生产写动作必须有不可变 Candidate、Manifest checksum、租约和精确目标 App/环境。

## 测试与验收

### 自动化测试

- 发布按钮权限、版本号二次确认、幂等点击和未满足门禁拒绝；
- 版本任务、阻塞项、平台汇总和 Android/小程序失败关闭；
- Candidate/Manifest 冻结、远端 ref、PR head 变化和回归证据；
- Web/API 预检、上传、切换、健康检查、回读、旧版本保护；
- 所有 enabled iOS App 的顺序、身份、上传、审核、自动上架和线上回读；
- 第三个配置 App 自动加入，不出现国家条件分支；
- 部分成功、拒审、超时、未知结果、崩溃、租约接管和补偿重试；
- 凭据脱敏和子进程环境允许列表；
- 只有全平台权威成功才发布版本和任务；
- 清理失败不撤销发布且可继续补偿。

### 真实验收

使用专门的验证版本：

1. 完成 Web/API 生产部署和权威回读；
2. 同步上传海外版和中国版；
3. 自动提交两款 App Store 审核；
4. 等待审核通过并立即自动上架；
5. 回读两款线上版本和 Web/API Candidate；
6. 确认版本及 Manifest 内任务进入「已发布」；
7. 核验 PR/分支/Worktree 清理与审计证据。

真实验收必须使用经用户明确指定的验证版本。在实施和自动测试阶段，不操作当前生产版本、不提交真实 App Review。

## 非目标

- 本期不实现 Android Google Play 或小程序正式发布；它们出现时失败关闭。
- 不允许 AI 自主决定发布、绕过人工确认或修改审核策略。
- 不实现“任一平台成功即发布版本”。
- 不在平台失败时自动回滚已成功平台。
- 不提供强制标记已发布的逃生按钮。


# Candidate 驱动的全平台正式发布设计

**日期：** 2026-08-12  
**状态：** 用户已批准设计，待规格确认

## 背景与问题

v1.0.3 的 38 个有效任务均已进入「待发布」，但 Dashboard 顶部将版本显示为「可发布」，详情却仍报告：

- 任务 `86d40ejq2` 缺少影响平台；
- `android`、`mini_program` 尚未配置生产发布。

这不是任务状态冲突，而是平台范围与发布能力尚未闭环。当前详情直接汇总 ClickUp 平台字段；顶部版本卡片则只检查任务状态和 blocker，二者没有复用同一发布资格判定。同时，当前正式发布器仅支持 Web、API、iOS，旧规格明确把 Android 和小程序失败关闭。

现场事实已经确认：

- Android 是 Web 的 TWA／壳应用；普通 Web 内容更新无需单独发布 Android，只有壳工程、原生配置、签名或商店制品变化才需要独立发布；
- 微信小程序位于主仓库 `apps/mp`，拥有独立代码、构建及发布渠道；
- v1.0.3 冻结 Candidate `944c68af5c635e7274c94fa83ccff67a3c31e6de` 相对基线实际修改了 `apps/mp` 的 8 个文件，因此该版本必须包含小程序发布目标；
- 版本满足门禁只代表「允许显示发布操作」，不得自动产生任何生产副作用；
- 用户在版本详情完成确认并点击一次「发布」，即构成本次冻结版本全部必需目标的完整授权，之后不再要求二次人工确认。小程序审核通过后由编排器自动正式发布。

## 目标

1. 用冻结 Candidate 的真实变更和当前已验收任务证据生成不可变发布目标计划。
2. 让 Dashboard 顶部、版本详情和发布 API 使用同一资格判定，不再出现“顶部可发布、详情阻塞”的矛盾。
3. 把 Android TWA 正确投影到 Web 或独立壳目标，禁止把所有 Android 标签都误当原生发布。
4. 增加微信小程序的本地构建、上传、提审、审核等待、自动发布和线上权威回读能力。
5. 保持既有 Web、API 与全 iOS App 的精确 Candidate、幂等、租约、恢复和脱敏保证。
6. 把“点击发布”设为唯一生产授权边界；准备、轮询、开发、测试以及门禁转绿均不得触发生产操作。

## 非目标

- 不因项目存在某个平台就无条件发布全部平台。
- 不把自由文本关键词或空 ClickUp 字段直接当作最终发布范围。
- 不把普通 Web 变化误判为 Android 壳包更新。
- 不在本功能开发、自动测试、dry-run 或运行态检查中连接微信发布后台、上传制品、提交审核、部署生产或迁移生产数据库。
- 不提供跳过平台、强制成功或人工篡改已发布结果的入口。
- 不承诺撤回已经提交至微信或 Apple 审核的版本；失败通过后续补偿处理。

## 一、统一的发布授权状态机

版本发布分为三个明确阶段：

1. **不可发布**：任务、blocker、平台证据、Candidate 或运行配置存在缺口。页面展示精确缺口，发布 API 失败关闭。
2. **可发布／待操作**：所有门禁通过，仅展示发布按钮。编排器不得自动生成发布命令、冻结 Manifest、执行数据库迁移、连接生产或调用平台写 API。
3. **发布中**：只有 `release_manager` 或 `admin` 在版本详情输入精确版本号并点击发布后，服务端才创建带 `versionId`、`requestId`、确认版本和当前状态 CAS 的发布 outbox；该命令是完整且唯一的生产授权。

点击后的授权覆盖冻结 Manifest 内的所有 required targets，包括数据库迁移、Web/API、必要的 Android 壳、全部 required iOS App 和小程序。编排器在同一次授权下自动等待外部审核、自动发布审核通过的小程序和 iOS App，并完成权威回读，不再次询问用户。

重复点击使用同一稳定 `requestId` 幂等复用；不同请求不得绕过已有 releasing／published 状态。没有有效发布 outbox 的定时轮询只能刷新只读诊断，不能进入任何生产适配器。

## 二、Candidate 驱动的平台范围

### 2.1 两层证据

发布范围由两层证据共同确定：

- **任务意图证据**：当前 accepted aggregate/version 绑定的 ClickUp 平台字段、分析／开发／提测结构化平台结果；用于说明任务声称影响哪些客户端。
- **Candidate 变更证据**：冻结 Candidate 相对其冻结基线的 Git 路径清单；用于证明本次版本实际包含哪些可发布制品变化。

任何平台必须有可追溯证据。任务字段为空时，不再仅凭描述关键词推断；系统以该任务已验收 PR 的变更路径、当前 accepted commit、版本集成结果和结构化作业证据恢复平台。若仍不能唯一判断，则保持“缺少平台证据”并失败关闭。

任务意图与实际路径冲突时禁止静默选择：

- 声称影响某独立客户端但 Candidate 无相应路径变化时，显示范围漂移并阻止发布；
- Candidate 修改独立客户端但任务证据未声明时，自动把该客户端加入 required target，同时显示“由 Candidate 路径补充”的可审计来源；
- API／共享协议变化可能影响客户端兼容性，但不等同于客户端包有变化；客户端是否需要重新发包仍由客户端路径或明确制品证据决定。

### 2.2 路径到目标的确定性映射

- `apps/web/**`、`apps/admin/**` 及 Web 构建直接依赖 → `web`；
- `apps/api/**`、`apps/worker/**`、`packages/db/**`、服务端运行依赖与数据库迁移 → `api`；
- `apps/ios/**` 或 iOS 构建直接依赖 → `ios`，并展开为注册表中全部 enabled iOS App；
- `apps/mp/**` 或小程序构建直接依赖 → `mini_program`；
- `apps/android-web-wrapper/**`、TWA Manifest、Digital Asset Links、Android 签名／版本／商店配置 → `android_twa`；
- 普通 `web` 变化可被已安装 TWA 在线承载，不额外生成 `android_twa`；
- `apps/android/**` 若存在非 TWA 原生变化，作为 `android_native` 显式失败关闭，除非未来另行实现对应适配器；
- 无法识别的发布相关路径保留为 unsupported，不得丢弃。

共享包通过仓库依赖图或明确的构建输入清单展开到其真实消费者；不得把一个共享包的改动机械映射到所有平台。

### 2.3 不可变发布计划

首次处理有效发布命令时，在任何生产副作用之前生成并冻结 `productionTargetPlan`，至少包括：

- Candidate SHA、基线 SHA、Manifest checksum；
- 精确任务 ID、accepted commit、平台证据来源；
- 路径变更摘要及路径映射规则版本；
- `web`、`api`、`android_twa`、`mini_program` 标志；
- 全部 required iOS App 的完整非秘密身份；
- 小程序 App ID、构建目录、版本、描述和私密凭据引用的非秘密标识；
- 每个目标的依赖顺序、成功条件与回读身份。

重试必须使用原冻结计划。当前工作区、ClickUp 字段、平台注册表或版本分支漂移时失败关闭，不得改写已冻结目标。

## 三、v1.0.3 的平台结论

v1.0.3 当前 Candidate 已确认包含 Web、API、iOS 和 `apps/mp` 实际变化，因此至少需要：

- Web／Admin 生产发布；
- API／Worker 与所需数据库迁移；
- 注册表内全部 enabled iOS App；
- 微信小程序构建、上传、提审、审核通过后自动发布及线上回读。

Android 字段不直接生成独立目标。只有 Candidate 存在 `apps/android-web-wrapper` 或等价 TWA 壳输入变化时才增加 `android_twa`；若仅 Web 内容变化，Android 用户随 Web 入口生效。实现阶段必须用冻结 Candidate 的精确 diff 得出最终布尔值并在确认弹窗展示。

任务 `86d40ejq2` 不允许通过手工伪造字段“消红”。系统应从该任务当前验收 PR／accepted commit 的精确变更路径和结构化证据恢复其发布范围；恢复结果必须在 Dashboard 展示来源。若证据不足，继续失败关闭。

## 四、微信小程序生产适配器

### 4.1 配置注册表

新增非秘密小程序发布注册表，至少包含：

- `id`、`name`、`enabled`；
- `appId`（当前仓库 Manifest 为 `wx1fdac5e27c6b5366`，执行时必须与私密配置权威值精确一致）；
- `sourceDirectory=apps/mp`；
- `buildCommand` 与产物目录；
- 版本号来源、版本描述模板；
- 上传、审核、发布、回读命令或适配器模块；
- 私钥和微信平台凭据的私密文件引用；
- 审核类目／页面配置的私密描述符引用。

注册表不得包含私钥、token 或完整审核敏感资料。缺少、权限过宽、App ID 不一致或命令不在允许列表时，发布前失败关闭。

### 4.2 阶段

小程序目标按以下阶段执行并持久化：

1. `test`：在冻结 Candidate 的 detached worktree 中执行 `apps/mp` lint、typecheck、单元／契约测试；
2. `build`：使用生产 API 配置构建 `mp-weixin`，校验无测试地址、调试入口、未授权域名和秘密；
3. `artifact`：记录 App ID、Candidate、版本、digest、包体和配置摘要；
4. `upload`：使用稳定幂等键上传代码；未知结果先权威查询，不直接重传；
5. `review_submit`：校验上传版本和审核配置后提交审核；
6. `review_wait`：跨 tick 只做权威 GET，等待通过或拒绝；
7. `release`：审核通过后自动调用正式发布，无第二次人工确认；
8. `live_readback`：从微信权威接口确认线上 App ID、版本、发布状态与 Candidate 制品身份。

微信平台若不提供可证明 Candidate 的线上字段，则以“上传代码 digest + 审核版本 identity + 正式发布记录”的闭环证据作为权威身份，三者必须一致。

### 4.3 幂等、租约与恢复

每个外部动作前后都验证版本级 lease 和 fencing token。上传、提审、发布使用稳定请求身份；进程崩溃或网络超时后先通过 GET／查询接口对账。

- 已上传不得重复上传；
- 已提交审核不得重复创建审核；
- 审核等待不得消耗为无限 POST 重试；
- 审核拒绝标记 `product_rework`，保留 Web/API/iOS 成功证据；
- 修复后在用户对同一冻结发布执行“重试失败步骤”时，只生成小程序的新版本 attempt；
- 已正式发布且回读一致的目标不可变复用。

## 五、发布顺序、数据库与失败处理

发布命令获授权后按冻结 DAG 执行：

1. 全目标无副作用预检；
2. 数据库备份和 Expand 迁移；
3. API／Worker 部署与业务健康检查；
4. Web／Admin 切换与业务健康检查；
5. 必需的 Android TWA 壳构建／发布；
6. iOS 与小程序上传、提审；
7. 跨 tick 等待审核并自动发布；
8. 全目标线上权威回读；
9. 版本和任务标记为已发布；
10. 独立执行 PR／分支／Worktree 清理。

生产数据库迁移只能出现在有效点击命令之后。迁移前必须创建可验证备份，执行 Prisma migration status，按 Expand／Contract 策略判断兼容性。迁移、API 或业务烟测失败时不得继续客户端发布；数据库不自动倒退，服务入口按已验证的旧版本安全回切。

Web/API 的成功门禁除基础 health 外，必须包含版本声明的业务烟测。对 v1.0.3，至少覆盖开小灶公开数据端点和每日课程关键读取，防止仅 `/health` 通过但业务接口因 Schema 漂移返回 500。

## 六、统一 Dashboard 与 API 判定

抽取单一 `releaseEligibility` 领域结果，由以下调用者共同使用：

- Dashboard 版本卡片的“可发布”标记；
- 版本详情的缺口与目标预览；
- 发布确认弹窗；
- `POST /versions/:id/publish` 服务端写入前重验；
- release coordinator 冻结 Manifest 前重验。

结果至少返回：`ready`、结构化 `gaps`、任务范围、平台证据、planned targets、runtime readiness 和授权状态。前端不得自行用 `38/38` 推导“可发布”。

确认弹窗必须显示：精确版本、Candidate、基线、任务数、Web/API、是否需要 Android TWA、全部 iOS App、小程序 App ID／版本，以及数据库迁移与自动提审／自动发布警告。用户输入精确版本并点击一次后即完成授权。

## 七、持久化与可观察性

扩展现有生产 release targets，使 `mini_program` 和可选 `android_twa` 成为合法平台，并为小程序保存：

- App ID、版本、构建 digest、upload identity；
- 审核 ID／状态、发布 ID／状态、线上回读 identity；
- 当前 stage、attempt、reconciliation、failure classification；
- started／updated／completed 时间；
- 受限且脱敏的错误与 evidence。

成功终态必须具备完整身份、权威回读和 `completed_at`，历史成功行不可更新或删除。Dashboard 只返回安全字段，不展示凭据路径、token、原始平台响应或完整 Manifest 私密引用。

## 八、安全边界

- 开发、测试和 dry-run 默认使用 fake adapter；测试中任何真实网络／生产命令调用都应硬失败。
- 生产适配器只有在消费经过权限、版本确认、状态 CAS 和幂等校验的发布 outbox 后才能加载。
- “版本已就绪”“轮询发现全部待发布”“恢复编排器”“运行测试”等事件都不是生产授权。
- Master pause 阻止新的外部动作；恢复后仍必须存在原有效发布命令才能继续。
- SSH、数据库、微信和 Apple 凭据仅从权限为 0600 的私密描述符读取；日志、D1、ClickUp 评论、Dashboard 和子进程错误统一脱敏。
- 不允许使用本机 mutable worktree 构建生产包；所有制品必须来自精确 detached Candidate。

## 九、验收标准

1. 版本卡片与详情对同一版本返回完全相同的 `ready`；存在任一 gap 时不显示可发布。
2. 38/38 仅表示任务状态就绪，不再单独等价于版本可发布。
3. `86d40ejq2` 的范围从当前验收提交和结构化证据恢复，来源可见；无法恢复时保持失败关闭。
4. Candidate 路径映射能区分普通 Web 与 Android TWA 壳变化。
5. v1.0.3 的 `apps/mp` 8 个变更使 `mini_program` 成为 required target。
6. 无发布点击时，跨多个 poll interval 仍没有 release outbox、production attempt、SSH、数据库迁移、上传、提审或发布。
7. 一次有效点击创建一个幂等发布命令；重复点击不重复外部动作。
8. 小程序本地生产构建从冻结 Candidate 完成，身份和安全扫描通过。
9. fake 微信适配器覆盖上传、未知结果 GET 恢复、提审、审核等待、拒绝、通过后自动发布及线上回读。
10. 审核通过后无需二次确认，编排器自动正式发布小程序。
11. 审核拒绝或单目标失败不重复 Web/API/iOS 已成功目标；重试只补偿失败目标。
12. 数据库迁移和业务烟测失败阻止后续发布并保护旧生产入口。
13. 只有 Web、API、必要 Android TWA、全部 required iOS App 与小程序均权威成功，版本及冻结任务才进入 `published`。
14. 全流程覆盖崩溃恢复、lease 接管、进程重启、重复点击、身份漂移、凭据脱敏和历史成功不可变。
15. 实施期所有自动验证为零真实生产／微信／Apple 副作用；真实发布只能由用户在页面点击 v1.0.3 发布触发。

## 十、实施分解

本设计按可独立审查的能力拆分：

1. 统一发布资格与 Candidate 路径平台解析；
2. Manifest／D1 模型扩展与迁移；
3. 微信小程序命令适配器和安全本地构建；
4. 小程序生命周期协调、恢复和自动发布；
5. 发布 DAG、数据库备份迁移与业务烟测；
6. Dashboard 统一展示、一次点击授权与进度；
7. 全链路 fake E2E、安全测试和无副作用运行态验收。

每项必须先有可观察的 RED，再进行最小 GREEN，并在进入下一项前完成独立代码审查。任何真实生产或平台写操作不属于实施验收。

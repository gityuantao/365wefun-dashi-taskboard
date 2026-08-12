# 正式发布门禁数据收口与诊断修复设计

## 背景与目标

v1.0.3 当前显示 38/39 个任务就绪，同时报告历史开放阻塞、36 个任务缺少影响平台、未支持平台、iOS 生产目标为空和生产配置缺失。现场核验表明这些信息混合了真实发布门禁与陈旧或错误诊断：唯一非就绪任务 `86d40exzg` 已取消；7 个已进入待发布的任务仍保留旧返工预算 blocker；旧任务快照缺少平台，但其分析、开发和提测作业保存了平台证据；AU/CN App 已配置，却因为生产 runtime 未就绪而从页面目标预览中消失。

本次修复让版本详情以可追溯证据计算发布范围和目标，清除与成功终态冲突的历史阻塞，准确展示配置缺口，并保持生产发布失败关闭。不会增加小程序发布能力，不会解除 `productionReleaseHold`，也不会产生 SSH 部署、生产 POST、App 上传、App Review 或正式发布副作用。

## 已确认的真实操作路径

用户在 Dashboard 打开版本详情后，前端请求 `GET /api/orchestration/dashboard/versions/:versionId`；`orchestration/dashboard/http-server.mjs` 调用 `buildVersionDetail()`；`orchestration/dashboard/queries.mjs` 从 ClickUp 快照、聚合状态、blockers、runner jobs、Manifest、production targets 和生产 runtime 目标注册表计算 `releaseReadiness`、任务清单和目标进度；前端据此显示红色缺口并决定是否展示发布操作。

真正点击发布仍走 Dashboard 严格确认 API、outbox、冻结 Candidate/Manifest 和 production coordinator。生产 runtime readiness 与 `productionReleaseHold` 在 adapter import 和外部副作用之前失败关闭。本次只修复详情计算和状态收口，不绕过该路径。

## 方案

### 1. 版本发布任务范围

未冻结 Manifest 时，版本范围只包含目标版本相同且状态不是 `canceled` 的任务。取消任务保留在 ClickUp、D1 和审计记录中，但不计入任务总数、就绪数、开放 blocker、平台汇总或发布 Manifest 预览。

Manifest 一旦冻结，任务范围继续以冻结的 `taskIds` 为准，不因后续 ClickUp 状态变化静默改写；若冻结任务缺失或状态漂移，继续显式失败关闭。这样修复当前 38/39 误报，同时不破坏不可变发布快照。

### 2. 历史 blocker 收口

任务首次权威进入 `ready_for_release` 时，在同一状态推进事务中解决该任务仍开放的 `rework_budget` blocker，写入 `resolved_at`，保留原 reason 和历史记录。只自动解决由编排器生成、且含 evidence 的返工预算 blocker；其他人工、依赖、安全或未知 blocker 不自动关闭。

为兼容修复前已经进入待发布的任务，增加一次幂等 reconciliation：仅对“当前 ClickUp/aggregate 均为 `ready_for_release`，且有新于 blocker 的验收通过/提测通过证据”的旧 `rework_budget` blocker执行相同 resolved 更新。缺少时序证据时保持开放并明确诊断，禁止仅为了页面变绿直接删除。

### 3. 平台证据收口与规范化

新增单一发布平台解析器，输出每个任务的 canonical release scope 及来源。未冻结 Manifest 时按以下优先级选择最新且完整的证据：

1. ClickUp 快照中的非空显式平台；
2. 当前成功开发作业的结构化 `result.platforms`；
3. 当前分析作业的结构化 `summary.platforms`；
4. 与当前验收提交精确绑定的 staging payload 平台。

候选证据必须属于当前任务和当前 accepted commit/aggregate version；历史失败轮次、陈旧提交或自由文本关键词不作为最终发布范围。每个结果返回 `source`，页面可以解释平台来自哪里。

规范化规则为：

- `服务端`、`server`、`backend` → `api`；
- `Web`、`web` → `web`；
- `iOS`、`ios` → `ios`；
- `小程序`、`mini-program`、`mini_program`、`mp-weixin` → `mini_program`；
- Android 原生仍为 `android` 并失败关闭；只有结构化开发证据明确说明课程由 Web/TWA 承载、且当前提交没有 Android 制品改动时，Android 投影为既有 `web` 目标并记录 `androidDelivery=web_twa`，不新增 Android 发布目标；
- 未知值保留为 unsupported，禁止静默丢弃。

同一 canonical 平台去重但保持确定顺序。缺平台只在所有权威来源均为空时报告。v1.0.3 的 `86d40bmd2` 将收口为 `api/web/ios/mini_program`；小程序继续显示“尚未配置生产发布平台”，这是准确的真实阻塞，不伪装成可发布。

### 4. iOS 生产目标展示

production runtime 同时暴露两种状态：

- `configuredApps`：只对 runtime 中非秘密 iOS registry 做结构校验后得到，用于安全的 Dashboard 目标预览；
- `apps`：只有完整生产 runtime readiness 为 ready 时才可供发布执行使用。

Dashboard 使用 `configuredApps` 展示 AU/CN 的安全字段（名称、App Store App ID、scheme、bundle ID、marketing version），即使生产 descriptor 缺失或 Hold 开启也不再误报“iOS 注册表为空”。发布 coordinator 仍只使用 readiness 门禁后的 `apps`，因此展示修复不会扩大执行权限。

如果 registry 自身无效，页面显示准确的 registry 错误；生产 descriptor 缺失和 Hold 状态分别展示，不用一个错误覆盖另一个。

### 5. 发布诊断与安全边界

版本详情把缺口分为四组并保持确定顺序：

1. 任务范围与就绪状态；
2. 当前有效 blocker；
3. 平台证据与未支持目标；
4. runtime 配置缺口和 production Hold。

`productionReleaseHold=true` 必须单独可见。即使任务数据全部收口，只要小程序未配置、两份生产私密 descriptor 不存在或 Hold 未明确解除，发布操作仍不可用。

本次不创建或猜测任何私密 descriptor，不修改凭据，不解除 Hold，不触发真实生产或 App Store 副作用。

## 数据迁移与运行态修复

代码上线后先执行只读 dry-run，输出将排除的 canceled task、拟解决 blocker ID、每个任务的 canonical platform/source 和 iOS configuredApps。只有 dry-run 与当前权威证据逐项一致时，才执行幂等 blocker reconciliation；不批量改写 ClickUp 平台字段，不删除历史作业或 blocker。

随后只重启 supervisor 管理的 orchestrator child，保持 supervisor 不变。运行态验收读取版本详情并验证任务数量、有效 blocker、平台缺口、AU/CN 目标、descriptor 缺口和 Hold；跨过至少一个 poll interval 后确认没有 release job、生产 target attempt 或外部发布活动新增。

## 验收标准

1. v1.0.3 版本任务范围排除 `86d40exzg`，不再显示 38/39 的取消任务误阻塞。
2. 7 个历史 `rework_budget` blocker 只有在存在更新的成功证据时被标记 resolved；记录不删除，其他 blocker 不受影响。
3. 旧任务可从当前结构化作业证据恢复平台；来源、提交和聚合版本可追溯，陈旧证据不能被采用。
4. 平台别名按上述规则规范化；Android/TWA 不虚构原生目标；`mini_program` 保持明确 unsupported。
5. 版本详情在 runtime 未就绪时仍显示 AU/CN 两个配置 iOS App，不再误报注册表为空。
6. 页面分别显示小程序未支持、缺失的私密 descriptor 和 production Hold；发布操作保持不可用。
7. 自动化覆盖任务范围、blocker 时序、平台来源优先级/陈旧证据、别名、TWA、未知平台、iOS preview/runtime execution 分离和零副作用。
8. 运行态验证不新增 release job/attempt，不部署、不上传、不提审、不发布。

## 非目标

- 不实现微信小程序上传、审核或发布适配器。
- 不实现 Google Play/原生 Android 发布。
- 不创建生产 descriptor 或猜测生产服务器/微信/App Store 配置。
- 不解除 production Hold，不替用户发起 v1.0.3 正式发布。

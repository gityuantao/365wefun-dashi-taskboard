# iOS 全 App TestFlight 门禁与 ClickUp 评论图片输入设计

## 1. 目标

本设计补齐两项强制规则：

1. 只要任务影响 iOS，提测时必须同步构建并上传所有已启用的 iOS App。当前至少包括海外版 `E365AU` 和中国版 `E365CN`；以后新增国家 App 时自动纳入同一门禁。所有 App 均在 App Store Connect 处理成功并加入各自的 Internal Testing 后，任务才允许进入 ClickUp「待测试」。
2. 分析、开发和验收 AI 必须读取最近 ClickUp 评论中的图片附件。只读取评论文字或图片 URL 不算已读取；图片必须作为真实多模态输入传给 Codex。图片缺失或读取失败时不得静默继续。

本设计不发布生产、不提交 App Review，也不改变各国家 App 的功能开关和商店元数据。

## 2. 已确认的现状

### 2.1 iOS 提测

当前任务级 staging 门禁只部署 API、Web 和管理后台。仓库包含 `E365AU` 与 `E365CN` target/scheme，但编排器没有可扩展的 iOS App 清单，也没有“全部 TestFlight 包完成处理并加入 Internal Testing”这一聚合门禁。历史上传依赖单次人工命令，因此可能只更新其中一个 App。

### 2.2 评论图片

ClickUp 客户端会调用评论接口，但 `buildCommentContext` 只提取 `comment_text`。`runCodex` 仅把文字写入标准输入，没有下载评论图片，也没有通过 Codex 图片参数传入本地文件。因此当前 AI 看不到评论截图中的界面、标注和报错。

## 3. 方案选择

采用配置驱动的强门禁：

- iOS App 通过清单登记，不在流程代码里写死两个 target。
- 每个 App 都有独立执行与证据，任务级门禁汇总所有结果。
- 评论图片由独立的附件收集器下载、校验和清理；AI 阶段只消费结构化评论上下文与本地图片列表。

未采用“脚本固定两个 App”，因为未来新增国家 App 会再次修改代码并容易漏发。未采用“上传成功即待测试”，因为上传后仍可能处理失败或未进入测试组。

## 4. iOS App 清单

运行配置新增 `iosApps` 数组。每个启用项至少包含：

```json
{
  "id": "au",
  "name": "海外版",
  "enabled": true,
  "scheme": "E365AU",
  "bundleId": "online.365english.app",
  "testFlightGroup": "Internal Testing",
  "buildNumberSource": "app-store-connect"
}
```

中国版以独立条目登记 `E365CN`、对应 bundle ID 和测试组。新增国家版本时必须先加入清单；凡 `enabled=true` 的 App 都自动成为 iOS 提测门禁的一部分。

配置加载时必须拒绝：重复 id、scheme 或 bundle ID，缺少测试组，空清单，以及无法解析的构建号策略。清单和非敏感标识可入库；Apple 凭据只从现有私密配置读取。

## 5. iOS 提测流程

任务影响平台包含 iOS 时，代码验收和测试环境 Web/API 部署成功后执行 `stage_ios_apps`：

1. 固化本次 Candidate SHA、目标版本和启用 App 清单快照。
2. 为每个 App 查询 App Store Connect 当前最大构建号，分配严格递增的新构建号。不同 App 可有不同构建号，但 marketing version 与任务目标版本一致。
3. 使用相同 Candidate 分别生成工程、测试、Archive 和 Export；国家差异仅由既有 target、编译配置和功能开关决定。
4. 验证归档的 bundle ID、marketing version、build number、API 环境和 Release 配置，禁止测试钩子或错误 bundle。
5. 上传每个 IPA，并保存 delivery/upload id。
6. 轮询 App Store Connect，直到对应 build 显示处理成功。
7. 将 build 加入清单指定的 Internal Testing group，并回读确认 membership。
8. 所有启用 App 均成功后，连同 Web/API staging 证据一起派发 `acceptance_passed`，进入「待测试」。

同一 App 的上传必须串行，防止构建号竞争；不同 App 默认也串行执行，以降低证书、DerivedData 和 Apple 限流冲突。后续只有在证据证明安全时才允许并行化。

## 6. iOS 失败与恢复

- 任意 App 构建、签名、上传、处理或加入测试组失败，整个 iOS 门禁失败，任务不得进入待测试。
- ClickUp 评论必须记录失败 App、scheme、bundle ID、marketing version、build number、失败阶段和脱敏错误。
- 已成功的 App 证据保留。重试时先回读 App Store Connect：已处理且已加入正确测试组的同一 Candidate build 不重复上传；仅重试缺失或失败的 App。
- 若重新开发产生新 Candidate，所有 App 都必须为新 Candidate 重新构建上传，不能混用旧包。
- Apple 长时间 Processing 使用明确超时；超时后任务退回待开发并记录原因，不得假定成功。
- 不允许因某个国家 App“本次功能被隐藏”而跳过。只要任务影响 iOS，所有启用 App 都必须同步更新。

## 7. 评论图片收集

新增评论附件收集器，输入 ClickUp 原始评论，输出：

```js
{
  textContext,
  images: [
    { commentId, date, filename, contentType, localPath, sourceUrl }
  ],
  cleanup()
}
```

处理规则：

1. 评论仍按时间倒序选择最近反馈，图片与所属评论保持绑定；只有图片、没有文字的评论也必须保留。
2. 从 ClickUp 评论结构中解析图片附件及内嵌图片，不依赖 `comment_text` 中是否出现 URL。
3. 使用 ClickUp 鉴权下载到任务专属、权限受限的临时目录；文件名不直接信任上游值。
4. 根据响应内容和文件签名校验实际类型，仅接受 Codex 支持的 PNG、JPEG、WebP 和 GIF 静态首帧策略；拒绝 HTML 错误页伪装成图片。
5. 对单图大小、总大小和图片数量设置上限，优先保留最新反馈。任何截断都必须写入上下文和 ClickUp 诊断，不能静默丢弃。
6. 下载失败、鉴权失败、内容损坏或所有关键图片均不可用时，当前 AI 作业失败关闭并转「待补充信息」，评论说明具体附件和原因。
7. 作业完成、失败、超时或取消后统一清理临时目录；图片不写入 Git、不进入长期日志，不跨任务复用。

## 8. AI 多模态输入

`runCodex` 扩展为接收 `imagePaths`，并以 Codex CLI 支持的图片参数逐项传入。提示词中的评论文字按评论 id 标记，并列出对应图片文件名，使模型能建立“这张图属于哪条反馈”的关系。

以下阶段必须使用同一收集规则：

- 分析：从图片识别问题范围、平台、错误提示和期望行为。
- 开发：优先处理最近验收截图展示的实际问题，禁止只依据旧文字反馈。
- 验收：对照历史失败截图，避免重复遗漏同一视觉或状态问题。

AI 输出不要求复述图片隐私内容，只需在分析、改动摘要或验收 findings 中引用与任务有关的观察。

## 9. 状态与证据

`ready_for_test/待测试` 的含义扩展为：

- Web/API 等任务所需测试环境已部署并通过回读；且
- 若影响 iOS，清单中所有启用 App 的 Candidate build 都已处理成功并加入 Internal Testing。

新增每 App 的 TestFlight 证据记录：task id、candidate SHA、app id、scheme、bundle ID、version、build、upload id、processing 状态、test group、membership 回读、时间和错误。

成功评论按 App 逐行列出版本、构建号和测试组。不得只写“TestFlight 已上传”而缺少具体 App 和 membership 证据。

## 10. 测试策略

### 10.1 iOS 门禁

- iOS 任务会为清单中的全部启用 App 创建执行项。
- `E365AU` 成功而 `E365CN` 失败时，不进入待测试。
- 两个 App 都上传但其中一个仍 Processing 时，不进入待测试。
- 两个 App 均处理成功但有一个未加入 Internal Testing 时，不进入待测试。
- 全部成功时恰好推进一次状态，并生成完整证据。
- 新增第三个国家 App 后无需修改流程代码，测试自动要求三个 App 全部成功。
- 非 iOS 任务不触发 TestFlight。
- 相同 Candidate 重试不重复上传已成功 App；新 Candidate 不复用旧 build。

### 10.2 评论图片

- 纯文字、图文混合和纯图片评论均能形成正确上下文。
- 最新优先选择不会拆散评论与图片关联。
- 图片实际作为 Codex 进程参数传入，而不只是出现在文字提示中。
- 鉴权下载、错误内容类型、损坏图片、超限、超时和取消均按失败关闭并清理。
- 分析、开发、验收三个入口都覆盖图片输入。
- 日志、评论和作业结果不泄露 ClickUp token 或本地临时路径中的敏感信息。

## 11. 验收条件

1. 任一影响 iOS 的任务，当前两个 App 都必须产生与同一 Candidate 对应的新 TestFlight build。
2. 两个 build 均在 App Store Connect 处理成功并加入各自 Internal Testing 后，任务才进入待测试。
3. 新增启用的国家 App 只需修改清单，即自动加入门禁。
4. 评论中的图片能在分析、开发和验收 Codex 调用中被真实读取，并保持与文字评论的对应关系。
5. 图片不可读、App 构建失败、Apple 处理失败或测试组 membership 缺失时，流程失败关闭并留下可操作原因。
6. 所有临时图片均在作业结束后清理；Apple 和 ClickUp 凭据不进入仓库、数据库或评论。

## 12. 非目标

- 不自动提交 App Review 或发布正式版本。
- 不修改国家版现有功能隐藏规则。
- 不要求非 iOS 任务上传 TestFlight。
- 不长期保存 ClickUp 评论图片。
- 不通过伪造、跳过或人工文字确认替代 App Store Connect 权威回读。

# 运营驾驶舱优化 + 编排总开关（MVP 第二阶段追加）设计

日期：2026-08-06
状态：待用户审阅
基础设计：`docs/superpowers/specs/2026-08-06-operations-dashboard-design.md`

## 1. 背景与目标

第一阶段驾驶舱已上线。本阶段追加两件事：

1. **编排总开关**：驾驶舱内提供一个全局开关，开启时 orchestrator 正常轮询 ClickUp 并处理任务/版本；关闭时跳过全部处理，但驾驶舱仍可查看最后一次数据。
2. **细节打磨**：按视觉排版、交互细节、信息清晰、数据展示四个方向优化驾驶舱，UI 尽量复用源项目「自动认领待办」菜单的外观语言。

## 2. 编排总开关

### 2.1 语义

- 开启（默认）：orchestrator 每个 tick 正常执行 poll / status sync / outbox / analyze / develop / accept / release coordinator。
- 关闭：orchestrator 每个 tick 跳过以上全部处理步骤，仅保留 dashboard 只读服务与开关端点；进行中的作业不硬杀，由现有租约/超时机制自然回收。
- 开关状态持久化在本机 `.data/orchestration-control.json`，不写入 ClickUp、不进入云端。

### 2.2 控制文件

`orchestration/control.mjs` 提供纯函数：

- `readControl(dbPath)`：读取并规范化 `{ enabled: boolean, updatedAt: string | null }`；文件缺失时按 `{ enabled: true, updatedAt: null }` 处理。
- `writeControl(dbPath, { enabled })`：原子写入（临时文件 + rename），返回新状态。
- `shouldProcess(control)`：`control.enabled === true`。

控制文件路径由 orchestrator 启动时传入，默认 `<PROJECT_ROOT>/.data/orchestration-control.json`，测试用临时目录。

### 2.3 控制端点

在 orchestrator 的本地 HTTP 服务（`orchestration/dashboard/http-server.mjs`）新增：

- `GET /api/orchestration/control` → `200 { enabled, updatedAt }`。
- `PUT /api/orchestration/control`，body `{ enabled: boolean }` → `200 { enabled, updatedAt }`。
- 非 GET/PUT → `405`；body 非法 → `400 INVALID_BODY`；写失败 → `500`。
- 仍只绑定 `127.0.0.1`；PUT 端点不要求鉴权（本机 loopback，与现有 dashboard 端点一致）。

### 2.4 Server 代理

`server/app.mjs` 对 `/api/orchestration/control` 增加 GET/PUT 代理：

- 保留 `assertLoopbackRequest`。
- GET/PUT 转发到 `http://127.0.0.1:{orchestrationPort}/api/orchestration/control`。
- 连接/读取失败 → `503 ORCHESTRATOR_UNAVAILABLE`（与 dashboard 代理一致）。
- 其他方法 → `405`。

### 2.5 Orchestrator tick 接入

`scripts/orchestrator.mjs` 每次 `tick()` 开头读取控制文件：

- `enabled === true`：执行现有全部处理步骤。
- `enabled === false`：直接返回，仅日志记录一条 `orchestration paused`（频率限制为每个 tick 一条）。
- dashboard server 与控制端点始终可用，不受开关影响。

### 2.6 前端

- `web/src/types.ts` 新增 `OrchestrationControl { enabled: boolean; updatedAt: string | null }`。
- `web/src/api.ts` 新增 `getOrchestrationControl()` 与 `setOrchestrationControl(enabled)`。
- `Dashboard.tsx` header 右侧新增开关：
  - 使用源项目 `.board-setting-switch` 开关样式与 `is-on` 状态类；
  - 状态文案「运行中 / 已暂停」，状态点样式复用 `.is-active / .is-paused`；
  - 切换失败显示错误条，orchestrator 不可用时禁用并提示。
- 开关状态与 dashboard 数据一起轮询刷新（15 秒间隔内不额外发请求；切换时立即写）。

## 3. UI 细节打磨

### 3.1 视觉排版

- 卡片增加 hover/焦点态，焦点可见性沿用现有 `:focus-visible` 规则。
- 空态升级：版本发布区显示「暂无待发布版本」，并补一句说明；活动/版本空态同样给出人话。
- 窄屏（< 720px）下驾驶舱保持单列且不横向溢出；区块间距与圆角沿用现有设计 token。
- 暗色模式下核对所有新增颜色使用 CSS 变量，不写死色值。

### 3.2 交互细节

- 详情抽屉：`Esc` 关闭、点击遮罩关闭、关闭后焦点回到触发按钮。
- 刷新按钮切换为「更新中」状态并禁用，避免重复点击。
- 版本/活动卡片 hover 有明确可点反馈（背景/边框变化）。

### 3.3 信息清晰

- 状态徽标中文与颜色统一，沿用现有状态色体系（进行中/待发布/发布失败/已发布/已取消）。
- 版本进度卡片增加「未就绪 N 个任务」辅助信息；若版本存在 open blocker，显示「存在阻塞任务」。
- 空态与错误态文案面向狗哥本人，不出现技术堆栈信息。

### 3.4 数据展示增强

- 进度条按就绪比例着色：就绪比例 ≥ 100% 用成功色，> 0 用主色，0 用中性色。
- 版本排序使用 `compareVersions`（已有工具），同版本名再按名称兜底。
- 活动时间相对化：5 分钟内「刚刚」、1 小时内「N 分钟前」、今天「HH:mm」、更早显示日期；`title` 保留完整 ISO 时间。
- 发布失败版本在卡片与详情中透出失败原因（若 `runner_jobs` 失败结果中有 error 信息）。

## 4. 不做的事（YAGNI）

- 不做跨设备/云端开关同步：开关只控制本机 orchestrator。
- 不做 ClickUp 字段控制开关。
- 不做开关审计日志。
- 不重构现有看板或自动化菜单。
- 不新增数据统计报表。

## 5. 测试与验证

- 新增测试：
  - `orchestration/control.mjs`：读写规范化、缺失文件默认开启、原子写入。
  - 控制端点：GET 默认开启、PUT 开启/关闭、405、非法 body。
  - server 代理：GET/PUT 转发、503、405。
  - `Dashboard.tsx`：渲染开关与状态文案、调用 `setOrchestrationControl`。
  - tick 跳过：`shouldProcess(false)` 时 orchestrator 不执行处理（通过纯函数 + 集成测试断言 tick 行为）。
- 回归：现有驾驶舱测试、orchestration 套件全部保持通过。
- 验证命令：`node --test`（相关套件）、`npm run typecheck`、`npm run build:web`。

## 6. 验收标准

1. 驾驶舱顶部显示编排总开关，默认开启，样式与源项目「自动认领待办」一致。
2. 关闭后 orchestrator 停止处理（tick 日志显示 paused），驾驶舱仍能打开并显示最后一次数据。
3. 重新开启后 orchestrator 恢复处理。
4. 四个优化方向的条目均落地且不影响既有功能。
5. 相关测试、typecheck、build 全部通过。

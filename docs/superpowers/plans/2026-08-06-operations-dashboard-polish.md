# 运营驾驶舱优化 + 编排总开关 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

日期：2026-08-06
状态：待执行
设计文档：`docs/superpowers/specs/2026-08-06-operations-dashboard-polish-design.md`

**Goal:** 驾驶舱顶部新增「编排总开关」，关闭时 orchestrator 跳过全部处理、驾驶舱仍可查看数据；同时按视觉排版、交互细节、信息清晰、数据展示四方向打磨驾驶舱，UI 样式复用源项目「自动认领待办」外观。

**Architecture:** 控制状态落 `.data/orchestration-control.json`；`orchestration/control.mjs` 提供读写与判定；orchestrator 本地 HTTP server 新增 `GET/PUT /api/orchestration/control`，server 做 loopback 代理；`tick()` 开头读控制文件，关闭时直接返回；前端 Dashboard header 新增复用 `.board-setting-switch` 样式的开关。

**Tech Stack:** Node.js 22.5+、原生 ESM、`node:test`、Miniflare/D1、React 19 + TypeScript、Vite。

## 全局约束

- 控制文件只影响本机 orchestrator；不写入 ClickUp、不进入云端。
- 控制端点只绑定 `127.0.0.1`；server 代理保留 `assertLoopbackRequest`。
- 关闭时进行中的作业不硬杀，由现有租约/超时机制回收。
- 所有新增 UI 样式复用 `styles.css` 的设计 token；开关复用 `.board-setting-switch` 与 `.is-on`。
- 不重构现有「自动认领待办」菜单，不改旧看板。

## 文件结构

| 文件 | 职责 |
|------|------|
| `orchestration/control.mjs` | 控制文件读写与判定（新增） |
| `orchestration/dashboard/http-server.mjs` | 新增 control 端点（修改） |
| `scripts/orchestrator.mjs` | tick 跳过 + 传 controlPath（修改） |
| `orchestration/dashboard/queries.mjs` | 版本卡片新增阻塞/失败信息（修改） |
| `server/app.mjs` | control 代理（修改） |
| `web/src/types.ts` | `OrchestrationControl` + 版本字段（修改） |
| `web/src/api.ts` | control API（修改） |
| `web/src/components/dashboard/*.tsx` | 开关与四方向优化（修改） |
| `web/src/components/dashboard/dashboard.css` | 新样式（修改） |
| 测试 | 见各任务 |

---

## Task 1: 编排控制模块

**Files:**
- Create: `orchestration/control.mjs`
- Test: `test/orchestration/control.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `test/orchestration/control.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  readControl,
  shouldProcess,
  writeControl,
} from "../../orchestration/control.mjs";

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orchestration-control-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("missing control file defaults to enabled", async (t) => {
  const dir = await tempDir(t);
  const control = await readControl(path.join(dir, "control.json"));
  assert.deepEqual(control, { enabled: true, updatedAt: null });
  assert.equal(shouldProcess(control), true);
});

test("writeControl persists enabled state and updates the timestamp", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "control.json");
  const written = await writeControl(file, { enabled: false });
  assert.equal(written.enabled, false);
  assert.equal(typeof written.updatedAt, "string");

  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.equal(raw.enabled, false);
  assert.equal(raw.updatedAt, written.updatedAt);

  const read = await readControl(file);
  assert.equal(read.enabled, false);
  assert.equal(shouldProcess(read), false);
});

test("readControl normalizes malformed files to disabled", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "control.json");
  await writeFile(file, "not json", "utf8");
  const control = await readControl(file);
  assert.equal(control.enabled, false);
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `node --test test/orchestration/control.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`（`control.mjs` 尚不存在）。

- [ ] **Step 3: 实现控制模块**

Create `orchestration/control.mjs`:

```js
import { mkdtemp, rename, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CONTROL = { enabled: true, updatedAt: null };

function normalize(raw) {
  if (raw && typeof raw === "object" && raw.enabled === false) {
    return { enabled: false, updatedAt: null };
  }
  return { ...DEFAULT_CONTROL };
}

export async function readControl(controlPath) {
  try {
    const raw = JSON.parse(await readFile(controlPath, "utf8"));
    return normalize(raw);
  } catch {
    return { ...DEFAULT_CONTROL };
  }
}

export function shouldProcess(control) {
  return control?.enabled === true;
}

export async function writeControl(controlPath, { enabled }) {
  if (typeof enabled !== "boolean") {
    throw new TypeError("enabled must be a boolean");
  }
  const updatedAt = new Date().toISOString();
  const value = { enabled, updatedAt };
  const dir = path.dirname(controlPath);
  const temp = await mkdtemp(path.join(dir, ".control-"));
  const tempFile = path.join(temp, "control.json");
  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempFile, controlPath);
  await rm(temp, { recursive: true, force: true });
  return value;
}
```

- [ ] **Step 4: 运行测试，验证通过**

Run: `node --test test/orchestration/control.test.mjs`
Expected: PASS（3 个测试全部通过）。

- [ ] **Step 5: 提交**

```bash
git add orchestration/control.mjs test/orchestration/control.test.mjs
git commit -m "feat: add orchestration control module"
```

---

## Task 2: Orchestrator 控制端点

**Files:**
- Modify: `orchestration/dashboard/http-server.mjs`
- Test: `test/orchestration/control-http.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `test/orchestration/control-http.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startDashboardServer } from "../../orchestration/dashboard/http-server.mjs";

test("control endpoints read and update the master switch", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "control-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const controlPath = path.join(dir, "control.json");

  const server = await startDashboardServer({ db: null, port: 0, controlPath });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  const initial = await fetch(`${base}/api/orchestration/control`);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).enabled, true);

  const updated = await fetch(`${base}/api/orchestration/control`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).enabled, false);

  const bad = await fetch(`${base}/api/orchestration/control`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: "yes" }),
  });
  assert.equal(bad.status, 400);

  const post = await fetch(`${base}/api/orchestration/control`, { method: "POST" });
  assert.equal(post.status, 405);
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `node --test test/orchestration/control-http.test.mjs`
Expected: FAIL（`/api/orchestration/control` 目前返回 404）。

- [ ] **Step 3: 实现端点**

Modify `orchestration/dashboard/http-server.mjs`：

- 新增 import：

```js
import { readControl, writeControl } from "../control.mjs";
```

- `startDashboardServer` 签名增加 `controlPath`，并在 `/api/orchestration/dashboard` 分支之前加入：

```js
      if (pathname === "/api/orchestration/control") {
        if (request.method === "GET") {
          return sendJson(response, 200, await readControl(controlPath));
        }
        if (request.method === "PUT") {
          let body;
          try {
            body = JSON.parse(await readRequestBody(request));
          } catch {
            return sendJson(response, 400, {
              error: { code: "INVALID_BODY", message: "Request body must be JSON" },
            });
          }
          if (body === null || typeof body !== "object" || Array.isArray(body)
            || typeof body.enabled !== "boolean") {
            return sendJson(response, 400, {
              error: { code: "INVALID_BODY", message: "enabled must be a boolean" },
            });
          }
          return sendJson(response, 200, await writeControl(controlPath, body));
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }
```

- 新增 helper：

```js
async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
```

- [ ] **Step 4: 运行测试，验证通过**

Run: `node --test test/orchestration/control-http.test.mjs`
Expected: PASS（1 个测试通过）。

- [ ] **Step 5: 提交**

```bash
git add orchestration/dashboard/http-server.mjs test/orchestration/control-http.test.mjs
git commit -m "feat: expose orchestration control endpoint"
```

---

## Task 3: Server control 代理

**Files:**
- Modify: `server/app.mjs`
- Test: `test/server-control-proxy.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `test/server-control-proxy.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTaskboardServer } from "../server/index.mjs";
import { startDashboardServer } from "../orchestration/dashboard/http-server.mjs";

test("server proxies control GET and PUT to the local orchestrator", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "control-proxy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const controlPath = path.join(dir, "control.json");
  const dashboard = await startDashboardServer({ db: null, port: 0, controlPath });
  t.after(() => dashboard.close());

  const app = createTaskboardServer({
    dataDirectory: path.join(dir, "app"),
    orchestrationPort: dashboard.port,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;

  const initial = await fetch(`${base}/api/orchestration/control`);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).enabled, true);

  const updated = await fetch(`${base}/api/orchestration/control`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).enabled, false);

  const post = await fetch(`${base}/api/orchestration/control`, { method: "POST" });
  assert.equal(post.status, 405);
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `node --test test/server-control-proxy.test.mjs`
Expected: FAIL（control 路径目前落到 404）。

- [ ] **Step 3: 实现代理**

Modify `server/app.mjs`：在 dashboard 代理分支之后、`let currentCloudConfig` 之前新增：

```js
      if (pathname === "/api/orchestration/control") {
        assertLoopbackRequest(request);
        if (request.method !== "GET" && request.method !== "PUT") {
          return methodNotAllowed(response, ["GET", "PUT"]);
        }
        const target = `http://127.0.0.1:${resolved.orchestrationPort}${pathname}${url.search}`;
        const init = {
          method: request.method,
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(5000),
        };
        if (request.method === "PUT") {
          init.headers["content-type"] = "application/json";
          init.body = await readRequestBody(request);
        }
        let upstream;
        try {
          upstream = await fetch(target, init);
        } catch (error) {
          console.error("orchestration control proxy error:", error);
          throw new ApiError(
            503,
            "ORCHESTRATOR_UNAVAILABLE",
            "Orchestrator control endpoint is not running",
            { port: resolved.orchestrationPort },
          );
        }
        const text = await upstream.text();
        const contentType = upstream.headers.get("content-type") ?? "application/json; charset=utf-8";
        response.writeHead(upstream.status, {
          "cache-control": "no-store",
          "content-type": contentType,
        });
        response.end(text);
        return;
      }
```

注意：`server/app.mjs` 已有 `readJson`，但控制 PUT 需要原始 body 字符串。在文件内新增 helper（若不存在）：

```js
async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
```

- [ ] **Step 4: 运行测试，验证通过**

Run: `node --test test/server-control-proxy.test.mjs`
Expected: PASS（1 个测试通过）。

- [ ] **Step 5: 提交**

```bash
git add server/app.mjs test/server-control-proxy.test.mjs
git commit -m "feat: proxy orchestration control through the taskboard server"
```

---

## Task 4: Orchestrator tick 接入总开关

**Files:**
- Modify: `scripts/orchestrator.mjs`
- Test: `test/orchestration/control-tick.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `test/orchestration/control-tick.test.mjs`：

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../../scripts/orchestrator.mjs", import.meta.url), "utf8");

test("orchestrator gates tick processing on the control switch", () => {
  assert.match(source, /import \{[^}]*readControl[^}]*\} from "\.\.\/orchestration\/control\.mjs"/);
  assert.match(source, /async function tick\(\)[\s\S]*?readControl\(controlPath\)/);
  assert.match(source, /shouldProcess\(control\)[\s\S]*?log\(`orchestration paused`\)/);
  assert.match(source, /startDashboardServer\(\{[\s\S]*?controlPath/);
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `node --test test/orchestration/control-tick.test.mjs`
Expected: FAIL（orchestrator 尚未接入）。

- [ ] **Step 3: 接入 tick**

Modify `scripts/orchestrator.mjs`：

- import 区新增：

```js
import { readControl, shouldProcess } from "../orchestration/control.mjs";
```

- 定义控制路径（在 `CONFIG_PATH` 附近）：

```js
const CONTROL_PATH = process.env.ORCHESTRATION_CONTROL_PATH
  ?? path.join(PROJECT_ROOT, ".data", "orchestration-control.json");
```

- `startDashboardServer` 调用增加：

```js
  controlPath: CONTROL_PATH,
```

- `tick()` 函数开头、`const now` 之后加入：

```js
  const control = await readControl(CONTROL_PATH);
  if (!shouldProcess(control)) {
    log("orchestration paused");
    return;
  }
```

- [ ] **Step 4: 运行测试与语法检查**

Run: `node --test test/orchestration/control-tick.test.mjs`
Expected: PASS（1 个测试通过）。

Run: `node --check scripts/orchestrator.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/orchestrator.mjs test/orchestration/control-tick.test.mjs
git commit -m "feat: pause orchestration processing from the master switch"
```

---

## Task 5: 后端查询增强（阻塞与未就绪信息）

**Files:**
- Modify: `orchestration/dashboard/queries.mjs`
- Modify: `test/orchestration/dashboard.test.mjs`

- [ ] **Step 1: 扩展失败测试**

Modify `test/orchestration/dashboard.test.mjs`，在「terminal, blocked and empty versions」测试中新增断言：

```js
  assert.equal(blocked.hasOpenBlockers, true);
  assert.equal(blocked.notReadyCount, 1);
  const failedCard = payload.versions.find((version) => version.name === "1.0.4");
  assert.equal(failedCard.hasOpenBlockers, false);
  assert.equal(failedCard.notReadyCount, 0);
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `node --test test/orchestration/dashboard.test.mjs`
Expected: FAIL（版本进度对象缺少 `hasOpenBlockers` / `notReadyCount`）。

- [ ] **Step 3: 实现字段**

Modify `orchestration/dashboard/queries.mjs` 的 `buildDashboard` versionProgress map：

```js
      const notReadyCount = tasksInVersion.filter(
        (task) => task.status !== "ready_for_release",
      ).length;
      const hasOpenBlockers = tasksInVersion.some(
        (task) => openTaskBlockers.has(task.id),
      );
```

并在返回对象中加入：

```js
        notReadyCount,
        hasOpenBlockers,
```

- [ ] **Step 4: 运行测试，验证通过**

Run: `node --test test/orchestration/dashboard.test.mjs`
Expected: PASS（6 个测试全部通过）。

- [ ] **Step 5: 提交**

```bash
git add orchestration/dashboard/queries.mjs test/orchestration/dashboard.test.mjs
git commit -m "feat: expose blocker and not-ready counts on version cards"
```

---

## Task 6: 前端类型与 API

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `test/dashboard-api.test.mjs`

- [ ] **Step 1: 扩展失败测试**

Modify `test/dashboard-api.test.mjs`，新增：

```js
test("control api and version fields are typed", () => {
  assert.match(typesSource, /export interface OrchestrationControl[\s\S]*?enabled: boolean;/);
  assert.match(typesSource, /export interface VersionProgress[\s\S]*?hasOpenBlockers: boolean;/);
  assert.match(typesSource, /export interface VersionProgress[\s\S]*?notReadyCount: number;/);
  assert.match(apiSource, /export async function getOrchestrationControl/);
  assert.match(apiSource, /export async function setOrchestrationControl/);
  assert.match(apiSource, /\/api\/orchestration\/control"/);
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `node --test test/dashboard-api.test.mjs`
Expected: FAIL（类型与 API 尚不存在）。

- [ ] **Step 3: 添加类型**

Modify `web/src/types.ts`，在 dashboard 类型附近新增：

```ts
export interface OrchestrationControl {
  enabled: boolean;
  updatedAt: string | null;
}
```

并在 `VersionProgress` 中加入：

```ts
  hasOpenBlockers: boolean;
  notReadyCount: number;
```

- [ ] **Step 4: 添加 API**

Modify `web/src/api.ts`：

- 在类型 import 加入 `OrchestrationControl`。
- 在 `getOrchestrationDashboard` 附近加入：

```ts
export async function getOrchestrationControl(signal?: AbortSignal): Promise<OrchestrationControl> {
  return request<OrchestrationControl>("/api/orchestration/control", { signal });
}

export async function setOrchestrationControl(enabled: boolean): Promise<OrchestrationControl> {
  return request<OrchestrationControl>("/api/orchestration/control", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}
```

- [ ] **Step 5: 运行测试与类型检查**

Run: `node --test test/dashboard-api.test.mjs`
Expected: PASS（3 个测试全部通过）。

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add web/src/types.ts web/src/api.ts test/dashboard-api.test.mjs
git commit -m "feat: add orchestration control types and api"
```

---

## Task 7: Dashboard 编排总开关

**Files:**
- Modify: `web/src/components/dashboard/Dashboard.tsx`
- Modify: `web/src/components/dashboard/dashboard.css`
- Modify: `test/dashboard-components.test.mjs`

- [ ] **Step 1: 扩展失败测试**

Modify `test/dashboard-components.test.mjs`，新增：

```js
test("dashboard renders the orchestration master switch", () => {
  assert.match(dashboardSource, /getOrchestrationControl/);
  assert.match(dashboardSource, /setOrchestrationControl/);
  assert.match(dashboardSource, /编排总开关/);
  assert.match(dashboardSource, /board-setting-switch/);
  assert.match(dashboardSource, /运行中|已暂停/);
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `node --test test/dashboard-components.test.mjs`
Expected: FAIL（Dashboard 尚无开关）。

- [ ] **Step 3: 实现开关**

Modify `web/src/components/dashboard/Dashboard.tsx`：

- import 新增：

```tsx
import {
  getOrchestrationControl,
  setOrchestrationControl,
} from "../../api";
```

- 类型 import 新增 `OrchestrationControl`。
- state 新增：

```tsx
  const [control, setControl] = useState<OrchestrationControl | null>(null);
  const [controlPending, setControlPending] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
```

- `load` 内同时拉取 control：

```tsx
      const [next, controlValue] = await Promise.all([
        getOrchestrationDashboard(signal),
        getOrchestrationControl(signal),
      ]);
      setPayload(next);
      setControl(controlValue);
```

- 新增切换函数：

```tsx
  async function toggleControl() {
    if (!control || controlPending) return;
    setControlPending(true);
    try {
      const next = await setOrchestrationControl(!control.enabled);
      setControl(next);
      setControlError(null);
    } catch (caught) {
      setControlError(caught instanceof ApiError ? caught.message : "无法更新编排总开关");
    } finally {
      setControlPending(false);
    }
  }
```

- header 右侧新增：

```tsx
        <div className="dashboard-control">
          <span className={`dashboard-control-dot${control?.enabled ? " is-active" : " is-paused"}`} />
          <span>{control?.enabled ? "运行中" : "已暂停"}</span>
          <button
            type="button"
            className={`board-setting-switch${control?.enabled ? " is-on" : ""}`}
            role="switch"
            aria-checked={control?.enabled ?? false}
            disabled={controlPending || !control}
            onClick={() => void toggleControl()}
          >
            <span aria-hidden="true" />
          </button>
          <span className="dashboard-control-label">编排总开关</span>
        </div>
```

Modify `web/src/components/dashboard/dashboard.css`：

```css
.dashboard-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-muted);
  color: var(--text-secondary);
  font-size: 12px;
}

.dashboard-control-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-quaternary);
}

.dashboard-control-dot.is-active {
  background: var(--success);
}

.dashboard-control-dot.is-paused {
  background: var(--warning);
}

.dashboard-control .board-setting-switch {
  transform: scale(0.82);
}

.dashboard-control-label {
  white-space: nowrap;
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `node --test test/dashboard-components.test.mjs`
Expected: PASS（8 个测试全部通过）。

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/dashboard test/dashboard-components.test.mjs
git commit -m "feat: add orchestration master switch to the dashboard"
```

---

## Task 8: UI 细节打磨

**Files:**
- Modify: `web/src/components/dashboard/ReleaseActions.tsx`
- Modify: `web/src/components/dashboard/VersionProgress.tsx`
- Modify: `web/src/components/dashboard/ActivityFeed.tsx`
- Modify: `web/src/components/dashboard/DetailDrawer.tsx`
- Modify: `web/src/components/dashboard/Dashboard.tsx`
- Modify: `web/src/components/dashboard/dashboard.css`
- Modify: `test/dashboard-components.test.mjs`

- [ ] **Step 1: 扩展失败测试**

Modify `test/dashboard-components.test.mjs`，新增：

```js
test("polish states and interactions are present", () => {
  assert.match(releaseActionsSource, /暂无待发布版本，所有版本都在推进中/);
  assert.match(versionProgressSource, /未就绪/);
  assert.match(versionProgressSource, /存在阻塞任务/);
  assert.match(activitySource, /刚刚|分钟前|toLocaleTimeString/);
  assert.match(drawerSource, /Escape/);
  assert.match(dashboardSource, /更新中/);
  assert.match(styles, /\.version-progress-fill\.is-complete/);
  assert.match(styles, /\.detail-drawer-overlay/);
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `node --test test/dashboard-components.test.mjs`
Expected: FAIL（新文案与类尚不存在）。

- [ ] **Step 3: 落地视觉/交互/信息/数据优化**

Modify `ReleaseActions.tsx`：空态文案改为「暂无待发布版本，所有版本都在推进中」。

Modify `VersionProgress.tsx`：

- 卡片 meta 区加入：

```tsx
                  {version.notReadyCount > 0 && (
                    <span className="version-progress-not-ready">未就绪 {version.notReadyCount} 个任务</span>
                  )}
                  {version.hasOpenBlockers && (
                    <span className="version-progress-blocked">存在阻塞任务</span>
                  )}
```

- 进度条 fill 按完成度加类：

```tsx
                    <span
                      className={`version-progress-fill${percent >= 100 ? " is-complete" : ""}`}
                      style={{ width: `${percent}%` }}
                    />
```

Modify `ActivityFeed.tsx`：新增相对时间函数：

```tsx
function formatActivityTime(value: string): string {
  const time = new Date(value).getTime();
  const delta = Date.now() - time;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  const date = new Date(value);
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
```

并把 `<time>` 改为：

```tsx
                <time className="activity-time" title={item.time}>
                  {formatActivityTime(item.time)}
                </time>
```

Modify `Dashboard.tsx`：

- 刷新按钮加载态与 `refreshing` state：

```tsx
  const [refreshing, setRefreshing] = useState(false);
```

`load` 内用 try/finally 维护 `refreshing`，按钮：

```tsx
        <button
          className="icon-button"
          type="button"
          aria-label={refreshing ? "更新中" : "刷新"}
          title={refreshing ? "更新中" : "刷新"}
          disabled={refreshing}
          onClick={() => void load()}
        >
          <LinearIcon name="recurrence" />
        </button>
```

- 抽屉外层渲染遮罩：

```tsx
      {drawer && (
        <>
          <div
            className="detail-drawer-overlay"
            aria-hidden="true"
            onClick={() => setDrawer(null)}
          />
          <DetailDrawer
            kind={drawer.kind}
            detail={detail}
            onClose={() => setDrawer(null)}
          />
        </>
      )}
```

Modify `DetailDrawer.tsx`：加 `Escape` 监听：

```tsx
import { useEffect } from "react";
```

```tsx
  useEffect(() => {
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", closeFromEscape);
    return () => document.removeEventListener("keydown", closeFromEscape);
  }, [onClose]);
```

Modify `dashboard.css`：

```css
.version-progress-fill.is-complete {
  background: var(--success);
}

.detail-drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 35;
}

.version-progress-not-ready {
  color: var(--text-tertiary);
  font-size: 11px;
}

.version-progress-blocked {
  color: var(--warning);
  font-size: 11px;
}

@media (max-width: 720px) {
  .dashboard {
    padding: 14px 12px 28px;
  }
  .dashboard-header {
    flex-direction: column;
    align-items: stretch;
  }
  .version-progress-card {
    grid-template-columns: minmax(80px, auto) auto 1fr;
  }
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `node --test test/dashboard-components.test.mjs`
Expected: PASS（9 个测试全部通过）。

Run: `npm run typecheck`
Expected: PASS。

Run: `npm run build:web`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/dashboard test/dashboard-components.test.mjs
git commit -m "feat: polish dashboard visuals, interactions and data details"
```

---

## Task 9: 全量验证

**Files:**
- 无新增代码；如验证发现问题，按对应 Task 修。

- [ ] **Step 1: 运行相关套件**

Run: `node --test test/orchestration/*.test.mjs test/dashboard-api.test.mjs test/dashboard-components.test.mjs test/dashboard-view.test.mjs test/board-views.test.mjs test/server-dashboard-proxy.test.mjs test/server-control-proxy.test.mjs`
Expected: PASS（全量相关套件）。

- [ ] **Step 2: 运行 typecheck 与 build**

Run: `npm run typecheck`
Expected: PASS。

Run: `npm run build:web`
Expected: PASS。

- [ ] **Step 3: 本地联调**

重启 orchestrator 与 server（配置存在时）：

```bash
node scripts/orchestrator.mjs
node server/index.mjs
```

Expected：
- 驾驶舱顶部显示「运行中」开关；
- 关闭后 orchestrator 日志出现 `orchestration paused`，驾驶舱仍可打开；
- 重新开启后日志恢复处理；
- 版本卡片显示「未就绪 N 个任务」「存在阻塞任务」；
- 抽屉 Esc/遮罩可关闭；刷新按钮显示「更新中」；活动时间相对化。

- [ ] **Step 4: 收尾提交**

如有修复产生的改动：

```bash
git add -A
git commit -m "fix: polish dashboard integration details"
```

如没有改动，跳过本步。

---

## 自审记录

**Spec coverage：**
- 编排总开关：Task 1（控制模块）＋ Task 2（控制端点）＋ Task 3（代理）＋ Task 4（tick 跳过）＋ Task 7（UI 开关）。
- 视觉排版：Task 8（hover/空态/响应式/暗色 token）。
- 交互细节：Task 8（Esc/遮罩/焦点/更新中）。
- 信息清晰：Task 5（阻塞与未就绪）＋ Task 8（文案）。
- 数据展示：Task 5（字段）＋ Task 8（进度着色/相对时间/失败徽标已有）。
- 样式复用：Task 7（`.board-setting-switch`）。
- 验证：Task 9。

**Placeholder scan：** 每个代码步骤均有完整代码或精确 diff；无 TBD。

**Type consistency：** `OrchestrationControl` 与 `readControl/writeControl` 返回一致；`VersionProgress` 新增字段与 `queries.mjs` 返回一致；`Dashboard` 使用 `control?.enabled` 三元渲染，类型安全。

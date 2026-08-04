# Phase 01 Domain Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立不依赖ClickUp或发布平台的任务／版本状态机、命令信封、追加审计账本和可重建D1投影骨架。

**Architecture:** 新领域代码放入 `orchestration/`，不把新状态塞进现有通用 Taskboard `shared/domain.mjs`。Cloud Worker只在本阶段增加无外部副作用的领域接口与持久层；原任务板API、SQLite和UI行为保持不变。

**Tech Stack:** Node.js 22.5+、原生 ESM、Cloudflare D1、Miniflare、`node:test`、Web Crypto API。

## Global Constraints

- 本阶段不连接ClickUp、Auth0、GitHub、Codex、服务器或任何商店。
- 本阶段不修改现有任务板状态 `backlog/todo/in_progress/in_review/blocked/done/canceled`。
- 领域时间由调用方注入RFC3339 UTC字符串；测试不得依赖真实时钟。
- ID在边界上均为非空字符串；不使用中文名称作为外部配置主键。
- 状态推进只能通过命令处理器，不能导出通用 `setStatus()`。
- 事件先追加，投影后更新；同一命令ID重复提交返回同一结果。
- 遵守仓库 `AGENTS.md`：每个任务先证明真实路径，再实现主路径，再演示。

---

### Task 1: Characterize Existing Cloud Path

**Files:**
- Create: `test/orchestration/existing-cloud-path.test.mjs`
- Reference: `cloud/src/index.mjs`
- Reference: `test/helpers/cloud-worker-harness.mjs`

**Interfaces:**
- Consumes: existing `createCloudWorkerHarness()`.
- Produces: a characterization test proving existing project/task API behavior remains unchanged.

- [ ] **Step 1: Write the characterization test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";

test("existing project and task path remains operational", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const project = await harness.request("/api/projects", {
    method: "POST", actorName: "owner", json: {
      id: "baseline", name: "Baseline", workspacePath: "/tmp/baseline",
    },
  });
  assert.equal(project.response.status, 201);
  const task = await harness.request("/api/tasks", {
    method: "POST", actorName: "owner", json: {
      projectId: "baseline", title: "Keep current path", description: "", status: "backlog",
    },
  });
  assert.equal(task.response.status, 201);
  assert.equal(task.body.task.status, "backlog");
});
```

- [ ] **Step 2: Run the focused test**

Run: `node --test test/orchestration/existing-cloud-path.test.mjs`

Expected: PASS against the unmodified cloud implementation. If it fails, correct the fixture to match the actual documented route before changing production code.

- [ ] **Step 3: Record the proven path in the commit body**

Record: `POST /api/projects → projects row → 201`, then `POST /api/tasks → tasks row → 201 → status backlog`.

- [ ] **Step 4: Commit**

```bash
git add test/orchestration/existing-cloud-path.test.mjs
git commit -m "test: characterize existing cloud task path"
```

### Task 2: Define Task and Version State Machines

**Files:**
- Create: `orchestration/domain/errors.mjs`
- Create: `orchestration/domain/task-state.mjs`
- Create: `orchestration/domain/version-state.mjs`
- Create: `test/orchestration/state-machines.test.mjs`

**Interfaces:**
- Produces: `DomainError`, `TASK_STATES`, `VERSION_STATES`, `decideTaskTransition(input)`, `decideVersionTransition(input)`.
- Return type: `{ from: string, to: string, eventType: string }`; invalid transitions throw `DomainError` with stable `code` and `details`.

- [ ] **Step 1: Write failing transition-table tests**

```js
test("task happy path is exact", () => {
  const path = ["inbox", "analyzing", "ready_for_development", "developing", "ready_for_test", "testing", "ready_for_acceptance", "accepting", "ready_for_release", "published"];
  for (let index = 0; index < path.length - 1; index += 1) {
    assert.equal(decideTaskTransition({ from: path[index], to: path[index + 1] }).to, path[index + 1]);
  }
});

test("test failure returns to ready for development", () => {
  assert.equal(decideTaskTransition({ from: "testing", to: "ready_for_development", evidenceId: "ev-1" }).eventType, "task.test_failed");
});

test("version cannot skip release preparation", () => {
  assert.throws(() => decideVersionTransition({ from: "active", to: "releasing" }), /INVALID_TRANSITION/);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test test/orchestration/state-machines.test.mjs`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement explicit immutable transition maps**

Implement task states `inbox, analyzing, ready_for_development, developing, ready_for_test, testing, ready_for_acceptance, accepting, ready_for_release, published, canceled` and version states `planning, active, ready_for_release, releasing, release_failed, published, canceled`. Require evidence IDs for failure returns and prohibit transitions out of `published` and `canceled`.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/orchestration/state-machines.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestration/domain/errors.mjs orchestration/domain/task-state.mjs orchestration/domain/version-state.mjs test/orchestration/state-machines.test.mjs
git commit -m "feat: add orchestration state machines"
```

### Task 3: Define Domain Errors, Commands, and Events

**Files:**
- Create: `orchestration/domain/commands.mjs`
- Create: `orchestration/domain/events.mjs`
- Create: `test/orchestration/command-envelope.test.mjs`

**Interfaces:**
- Consumes: `DomainError` from Task 2.
- Produces: `parseCommandEnvelope(value)`, `createDomainEvent(input)`.
- Command shape: `{ id, type, aggregateType, aggregateId, expectedVersion, actorId, issuedAt, reason, parameters }`.
- Event shape: `{ id, sequence, aggregateType, aggregateId, aggregateVersion, type, commandId, actorId, occurredAt, data, previousHash, hash }`.

- [ ] **Step 1: Write failing strict-schema tests**

```js
test("command rejects unknown fields and mutable names", () => {
  assert.throws(() => parseCommandEnvelope({
    id: "cmd-1", type: "start_analysis", aggregateType: "task", aggregateId: "task-1",
    expectedVersion: 1, actorId: "subject-1", issuedAt: "2026-08-04T00:00:00.000Z",
    reason: "accepted scope", parameters: {}, statusName: "分析中",
  }), /UNKNOWN_FIELD/);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test test/orchestration/command-envelope.test.mjs`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement strict parsers and canonical event serialization**

Use sorted JSON object keys for hashing, SHA-256 through `crypto.subtle`, RFC3339 UTC validation, positive integer versions, and a 4 KiB maximum for serialized command parameters.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/orchestration/command-envelope.test.mjs`

Expected: PASS for valid envelopes and deterministic hashes; FAIL cases return stable error codes.

- [ ] **Step 5: Commit**

```bash
git add orchestration/domain/commands.mjs orchestration/domain/events.mjs test/orchestration/command-envelope.test.mjs
git commit -m "feat: define orchestration command and event contracts"
```

### Task 4: Add the Orchestration D1 Schema

**Files:**
- Create: `cloud/migrations/0002_orchestration_core.sql`
- Create: `test/orchestration/orchestration-migration.test.mjs`
- Modify: `test/helpers/cloud-worker-harness.mjs`

**Interfaces:**
- Produces tables: `orchestration_commands`, `orchestration_events`, `orchestration_aggregates`, `orchestration_external_refs`, `orchestration_approvals`, `orchestration_leases`.
- Preserves every table from `0001_initial.sql`.

- [ ] **Step 1: Extend the harness to apply all migrations in filename order**

Replace the single `MIGRATION_PATH` read with `readdir(cloud/migrations)`, filter `/^\d+.*\.sql$/`, sort lexically, and execute each file.

- [ ] **Step 2: Write the failing schema test**

```js
test("orchestration schema enforces command idempotency", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const names = await harness.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'orchestration_%' ORDER BY name").all();
  assert.deepEqual(names.results.map(({ name }) => name), [
    "orchestration_aggregates", "orchestration_approvals", "orchestration_commands",
    "orchestration_events", "orchestration_external_refs", "orchestration_leases",
  ]);
});
```

- [ ] **Step 3: Run and verify failure**

Run: `node --test test/orchestration/orchestration-migration.test.mjs`

Expected: FAIL because the tables do not exist.

- [ ] **Step 4: Create the migration**

Use text IDs, integer aggregate versions, unique command IDs, unique `(aggregate_type, aggregate_id, aggregate_version)`, unique `(source, external_id)`, lease fencing tokens, RFC3339 timestamp text fields, and JSON text with `json_valid` checks.

- [ ] **Step 5: Run migration and existing cloud tests**

Run: `node --test test/orchestration/orchestration-migration.test.mjs test/cloud-shared-worker.test.mjs test/cloud-migration.test.mjs`

Expected: PASS; existing tables and routes remain operational.

- [ ] **Step 6: Commit**

```bash
git add cloud/migrations/0002_orchestration_core.sql test/helpers/cloud-worker-harness.mjs test/orchestration/orchestration-migration.test.mjs
git commit -m "feat: add orchestration D1 schema"
```

### Task 5: Implement Event Store and Projection Repository

**Files:**
- Create: `orchestration/persistence/d1-event-store.mjs`
- Create: `orchestration/persistence/d1-aggregate-store.mjs`
- Create: `test/orchestration/d1-event-store.test.mjs`

**Interfaces:**
- Produces: `appendCommandResult(db, { command, events, projection })`, `loadAggregate(db, type, id)`, `loadCommandResult(db, commandId)`.
- `appendCommandResult` executes command row, event rows, and projection update in one D1 batch/transactional unit and uses expected aggregate version.

- [ ] **Step 1: Write failing idempotency and optimistic-lock tests**

Test that submitting `cmd-1` twice creates one command and one event, and that two commands both expecting aggregate version 1 cannot both advance it to version 2.

- [ ] **Step 2: Run and verify failure**

Run: `node --test test/orchestration/d1-event-store.test.mjs`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the minimal D1 repositories**

Use prepared statements only. On existing command ID, return the stored result without appending. On version mismatch throw `DomainError("VERSION_CONFLICT")`. Verify `previous_hash` against the current aggregate event head before append.

- [ ] **Step 4: Run focused and migration tests**

Run: `node --test test/orchestration/d1-event-store.test.mjs test/orchestration/orchestration-migration.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestration/persistence/d1-event-store.mjs orchestration/persistence/d1-aggregate-store.mjs test/orchestration/d1-event-store.test.mjs
git commit -m "feat: persist orchestration events and projections"
```

### Task 6: Implement the Pure Command Dispatcher

**Files:**
- Create: `orchestration/application/dispatch-command.mjs`
- Create: `orchestration/application/task-command-handlers.mjs`
- Create: `orchestration/application/version-command-handlers.mjs`
- Create: `test/orchestration/dispatch-command.test.mjs`

**Interfaces:**
- Produces: `dispatchCommand({ db, command, now }) -> Promise<{ commandId, status, aggregateType, aggregateId, version, events }>`.
- Consumes state decisions from Task 2 and persistence interfaces from Task 5.

- [ ] **Step 1: Write failing end-to-end domain tests**

Cover `start_analysis`, `analysis_completed`, `start_development`, `development_completed`, `start_test`, `test_passed`, `test_failed`, `start_acceptance`, `acceptance_passed`, `acceptance_failed`, `prepare_release`, `start_release`, `release_succeeded`, and `release_failed`.

- [ ] **Step 2: Run and verify failure**

Run: `node --test test/orchestration/dispatch-command.test.mjs`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement explicit handler maps**

Each command handler validates aggregate type, current state, expected version and required evidence. Do not accept a target status from the caller; the command type determines the transition.

- [ ] **Step 4: Run all orchestration tests**

Run: `node --test test/orchestration/*.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestration/application test/orchestration/dispatch-command.test.mjs
git commit -m "feat: dispatch orchestration commands"
```

### Task 7: Add a Local-Only Diagnostic API Slice

**Files:**
- Create: `cloud/src/orchestration-routes.mjs`
- Modify: `cloud/src/index.mjs`
- Create: `test/orchestration/orchestration-api.test.mjs`

**Interfaces:**
- Produces: `routeOrchestrationRequest(request, env, actor)`.
- Endpoints: `POST /api/orchestration/commands` and `GET /api/orchestration/commands/:id`.
- Phase-01 gate: routes return `404 ORCHESTRATION_DISABLED` unless `ORCHESTRATION_DIAGNOSTIC_ENABLED === "true"`.

- [ ] **Step 1: Write disabled-by-default and happy-path tests**

Test default 404, enabled command acceptance `202 { commandId, status }`, duplicate idempotency, version conflict `409`, and unknown field `400`.

- [ ] **Step 2: Run and verify failure**

Run: `node --test test/orchestration/orchestration-api.test.mjs`

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement the smallest route adapter**

Parse a maximum 64 KiB JSON body, call `parseCommandEnvelope`, dispatch the command, map `DomainError` codes to stable HTTP responses, and expose no generic status mutation endpoint.

- [ ] **Step 4: Run focused tests and the full repository check**

Run: `node --test test/orchestration/orchestration-api.test.mjs`

Expected: PASS.

Run: `npm run check`

Expected: typecheck, production build and all tests PASS.

- [ ] **Step 5: Demonstrate the direct path locally**

With Miniflare only: `POST command → orchestration_commands row → orchestration_events row → orchestration_aggregates version increment → GET command result`. Do not deploy.

- [ ] **Step 6: Commit**

```bash
git add cloud/src/index.mjs cloud/src/orchestration-routes.mjs test/orchestration/orchestration-api.test.mjs
git commit -m "feat: expose disabled orchestration diagnostic API"
```

## Phase 01 Acceptance

- [ ] Existing Taskboard cloud path remains unchanged.
- [ ] Every valid task/version transition has an explicit test; invalid jumps fail with stable codes.
- [ ] Duplicate command IDs are idempotent and concurrent expected-version writes conflict.
- [ ] Event hashes are deterministic and previous-hash tampering is detected.
- [ ] D1 projections rebuild from events in a test fixture.
- [ ] Diagnostic API is disabled by default and performs no external integration.
- [ ] `npm run check` passes.
- [ ] User reviews the demonstrated local path before Phase 02 planning or any deployment.

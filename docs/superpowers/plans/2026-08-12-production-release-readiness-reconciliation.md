# Production Release Readiness Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make v1.0.3 release readiness use authoritative active-task, blocker, platform, and configured-iOS evidence while keeping unsupported mini-program, missing private descriptors, and the production Hold fail-closed.

**Architecture:** A shared release-scope resolver will derive active version tasks and canonical per-task platforms from persisted structured evidence. Both the authoritative version gate and Dashboard detail will consume that resolver, while blocker reconciliation remains an explicit idempotent state-transition concern and production runtime separates safe configured-App preview from execution-ready Apps. A dry-run-first operational command will reconcile only evidence-backed historical blockers and will never touch ClickUp status, production adapters, or external release systems.

**Tech Stack:** Node.js ESM, Cloudflare D1/Miniflare, Node test runner, existing orchestration domain/application/dashboard modules, React Dashboard API contracts.

## Global Constraints

- Pre-Manifest scope excludes tasks whose canonical status is `canceled`; frozen Manifest scope remains immutable.
- Platform evidence order is explicit ClickUp snapshot, current successful develop result, current analysis result, then commit/version-bound staging payload.
- Canonical platforms are `web`, `api`, `ios`, `mini_program`, `android`, plus preserved unsupported unknown values.
- `服务端/server/backend → api`; Android may project to `web` only with structured `web_twa` delivery evidence and no native artifact change.
- `mini_program` and native `android` remain unsupported and block production release.
- Dashboard may preview structurally valid configured iOS Apps, but production execution may use Apps only after full runtime readiness.
- `productionReleaseHold` stays `true`; no descriptor guessing, SSH deployment, production POST, App upload, App Review, or release is authorized.
- Historical rows are resolved, never deleted; reconciliation must be dry-run-first and idempotent.

---

### Task 1: Shared active-task and release-platform evidence resolver

**Files:**
- Create: `orchestration/release/release-scope.mjs`
- Modify: `orchestration/domain/platforms.mjs`
- Test: `test/orchestration/release-scope.test.mjs`
- Test: `test/orchestration/platforms.test.mjs`

**Interfaces:**
- Produces `activeVersionTasks({ tasks, versionName, manifest })` returning the immutable Manifest task set or non-canceled matching snapshots.
- Produces `resolveReleasePlatformEvidence({ task, developJobs, analyzeJobs, stageJobs, aggregate })` returning `{ taskId, platforms, source, evidenceId, commitSha, aggregateVersion, androidDelivery }`.
- Produces `canonicalizeReleasePlatforms(values, metadata)` with deterministic deduplication and unsupported preservation.

- [ ] **Step 1: Write failing active-scope and platform-evidence tests**

Add real-data-shaped tests proving: canceled tasks are excluded before Manifest; frozen canceled task IDs remain; explicit non-empty snapshot wins; empty snapshot falls through to current successful develop, analysis, then exact stage payload; failed/stale/wrong-task/wrong-commit evidence is rejected; all-empty evidence remains missing.

- [ ] **Step 2: Run the focused tests and record RED**

Run:

```bash
node --test test/orchestration/release-scope.test.mjs test/orchestration/platforms.test.mjs
```

Expected: fail because the release-scope API and canonical aliases do not exist.

- [ ] **Step 3: Implement canonicalization and evidence resolution**

Implement exact aliases, source metadata, aggregate/commit validation, `mini_program` preservation, and Android `web_twa` projection. Do not use free-text inference as final release evidence.

- [ ] **Step 4: Verify GREEN and regress existing platform behavior**

Run:

```bash
node --test test/orchestration/release-scope.test.mjs test/orchestration/platforms.test.mjs test/orchestration/production-platform-gate.test.mjs
```

- [ ] **Step 5: Commit Task 1**

```bash
git add orchestration/release/release-scope.mjs orchestration/domain/platforms.mjs test/orchestration/release-scope.test.mjs test/orchestration/platforms.test.mjs
git commit -m "feat: resolve authoritative release scope"
```

### Task 2: Use the shared scope in the real release gate and Dashboard

**Files:**
- Modify: `orchestration/release/version-aggregator.mjs`
- Modify: `orchestration/dashboard/queries.mjs`
- Test: `test/orchestration/version-aggregator.test.mjs`
- Test: `test/orchestration/dashboard.test.mjs`

**Interfaces:**
- Consumes Task 1 active scope and platform evidence.
- Produces identical task IDs and canonical platform blockers at the authoritative gate and the read-only Dashboard.
- Adds safe per-task platform diagnostics `{ taskId, platforms, source }` to version detail without raw job payloads or secrets.

- [ ] **Step 1: Write failing parity tests**

Cover a 39-task-shaped version where one canceled task yields 38/38; a frozen Manifest retains exact IDs; historical job evidence fills empty snapshots; unsupported `mini_program` blocks both gate and page; Dashboard and `checkVersionGate()` return the same active task IDs.

- [ ] **Step 2: Run RED**

```bash
node --test test/orchestration/version-aggregator.test.mjs test/orchestration/dashboard.test.mjs
```

Expected: canceled task remains and Dashboard/gate disagree or report missing platforms.

- [ ] **Step 3: Wire the shared resolver into both production paths**

Load only the necessary structured runner-job columns, bind evidence to current aggregate/accepted commit, preserve frozen Manifest behavior, and group gaps deterministically as task, blocker, platform, runtime/Hold.

- [ ] **Step 4: Verify GREEN and HTTP contract compatibility**

```bash
node --test test/orchestration/version-aggregator.test.mjs test/orchestration/dashboard.test.mjs test/orchestration/dashboard-http.test.mjs test/orchestration/release-commands.test.mjs
```

- [ ] **Step 5: Commit Task 2**

```bash
git add orchestration/release/version-aggregator.mjs orchestration/dashboard/queries.mjs test/orchestration/version-aggregator.test.mjs test/orchestration/dashboard.test.mjs
git commit -m "fix: align release gate readiness evidence"
```

### Task 3: Resolve rework blockers on authoritative release readiness

**Files:**
- Create: `orchestration/application/blocker-reconciliation.mjs`
- Modify: `cloud/src/clickup-poller.mjs`
- Test: `test/orchestration/blocker-reconciliation.test.mjs`
- Test: `test/orchestration/clickup-poller.test.mjs`

**Interfaces:**
- Produces `resolveSatisfiedReworkBlockers({ db, taskId, now, dryRun })` returning `{ eligible, resolved, skipped }` with blocker/evidence IDs.
- Poller invokes it after an authoritative `test_passed` transition reaches `ready_for_release`.
- Eligibility requires open `rework_budget`, current ClickUp and aggregate release readiness, and later successful test/acceptance evidence.

- [ ] **Step 1: Write failing blocker chronology tests**

Cover later success resolves; success before blocker does not; snapshot-only readiness does not; non-rework/manual blocker does not; repeated calls are idempotent; poller transition and blocker resolution are observable in one processing cycle.

- [ ] **Step 2: Run RED**

```bash
node --test test/orchestration/blocker-reconciliation.test.mjs test/orchestration/clickup-poller.test.mjs
```

- [ ] **Step 3: Implement evidence-backed resolution**

Update only `status='open' AND type='rework_budget'` rows with exact IDs and `resolved_at`; retain reason and row. Return an audit object and perform no ClickUp mutation beyond the existing status flow.

- [ ] **Step 4: Verify GREEN and failure-budget compatibility**

```bash
node --test test/orchestration/blocker-reconciliation.test.mjs test/orchestration/clickup-poller.test.mjs test/orchestration/failure-handler.test.mjs test/orchestration/version-aggregator.test.mjs
```

- [ ] **Step 5: Commit Task 3**

```bash
git add orchestration/application/blocker-reconciliation.mjs cloud/src/clickup-poller.mjs test/orchestration/blocker-reconciliation.test.mjs test/orchestration/clickup-poller.test.mjs
git commit -m "fix: resolve satisfied rework blockers"
```

### Task 4: Separate configured iOS preview from execution readiness

**Files:**
- Modify: `orchestration/release/production-runtime.mjs`
- Modify: `scripts/orchestrator.mjs`
- Modify: `orchestration/dashboard/http-server.mjs`
- Test: `test/orchestration/production-runtime-wiring.test.mjs`
- Test: `test/orchestration/dashboard-http.test.mjs`
- Test: `test/orchestration/dashboard.test.mjs`

**Interfaces:**
- `createProductionRuntime()` exposes immutable `configuredApps` after registry-only validation and keeps `apps` empty unless full readiness is true.
- Dashboard receives `productionTargetApps: productionRuntime.configuredApps`.
- Release coordinator continues receiving `productionRuntime.apps` and cannot execute while held or misconfigured.

- [ ] **Step 1: Write failing preview/execution separation tests**

Assert missing production descriptor plus Hold still exposes safe AU/CN preview fields; execution Apps remain empty; adapter import count is zero; invalid registry produces no preview and an exact registry diagnostic; no secret review configuration reaches the Dashboard.

- [ ] **Step 2: Run RED**

```bash
node --test test/orchestration/production-runtime-wiring.test.mjs test/orchestration/dashboard-http.test.mjs test/orchestration/dashboard.test.mjs
```

- [ ] **Step 3: Implement the two-view runtime registry**

Split registry-only validation from full runtime validation without weakening existing paths, command, credential, timeout, descriptor, or Hold checks.

- [ ] **Step 4: Verify GREEN and production failure closure**

```bash
node --test test/orchestration/production-runtime-wiring.test.mjs test/orchestration/dashboard-http.test.mjs test/orchestration/dashboard.test.mjs test/orchestration/production-release-security.test.mjs
```

- [ ] **Step 5: Commit Task 4**

```bash
git add orchestration/release/production-runtime.mjs scripts/orchestrator.mjs orchestration/dashboard/http-server.mjs test/orchestration/production-runtime-wiring.test.mjs test/orchestration/dashboard-http.test.mjs test/orchestration/dashboard.test.mjs
git commit -m "fix: preview configured iOS release targets"
```

### Task 5: Dry-run-first historical reconciliation and live verification

**Files:**
- Create: `scripts/reconcile-release-readiness.mjs`
- Modify: `package.json`
- Modify: `docs/开发记录.md`
- Test: `test/orchestration/release-readiness-reconciliation.test.mjs`
- Create: `.superpowers/sdd/2026-08-12-production-release-readiness-reconciliation/task-5-report.md` (ignored evidence report)

**Interfaces:**
- CLI defaults to read-only and emits sanitized JSON: canceled exclusions, blocker candidates, canonical task platforms/source, configured iOS previews, runtime gaps, Hold.
- `--apply-blockers` requires the exact version ID and only invokes Task 3 reconciliation for dry-run-eligible IDs.
- CLI never writes ClickUp, runner jobs, release attempts, production targets, external systems, runtime config, or credentials.

- [ ] **Step 1: Write failing CLI safety and exact-target tests**

Use a temporary D1 fixture to prove default zero writes, exact eligible IDs, wrong version rejection, idempotent apply, no non-blocker mutations, safe output, and persistent unsupported mini-program/Hold diagnostics.

- [ ] **Step 2: Run RED, implement the CLI, then run GREEN**

```bash
node --test test/orchestration/release-readiness-reconciliation.test.mjs
```

- [ ] **Step 3: Run focused and full automated verification**

```bash
node --test test/orchestration/release-scope.test.mjs test/orchestration/platforms.test.mjs test/orchestration/version-aggregator.test.mjs test/orchestration/dashboard.test.mjs test/orchestration/dashboard-http.test.mjs test/orchestration/blocker-reconciliation.test.mjs test/orchestration/clickup-poller.test.mjs test/orchestration/production-runtime-wiring.test.mjs test/orchestration/release-readiness-reconciliation.test.mjs
pnpm test:orchestration
pnpm build
node --check scripts/reconcile-release-readiness.mjs
node --check scripts/orchestrator.mjs
node --check cloud/src/clickup-poller.mjs
git diff --check
```

- [ ] **Step 4: Execute production-data dry-run and inspect every proposed mutation**

Run the CLI without `--apply-blockers`; compare the exact canceled task, blocker IDs, platform sources, AU/CN preview, mini-program gap, descriptor gaps, and Hold against read-only D1/runtime evidence. Do not apply if any item differs.

- [ ] **Step 5: Apply only the approved evidence-backed blocker reconciliation**

Run with exact v1.0.3 ID and `--apply-blockers`; verify changed row count and re-query every blocker. Do not change ClickUp task status or platform fields.

- [ ] **Step 6: Restart only the orchestrator child and verify live behavior**

Keep the supervisor PID unchanged. Verify 47823 and 47824 HTTP 200, v1.0.3 active count excludes canceled, no stale eligible blockers, canonical platform diagnostics, AU/CN preview, mini-program unsupported, both descriptor errors, and Hold. Wait across one poll interval and prove no new release job, production attempt/target, deploy, upload, review, or release activity.

- [ ] **Step 7: Update source and customer records**

Update `docs/开发记录.md`, the customer project `docs/开发记录.md`, `沟通记录/当前沟通.md`, `沟通记录/交接摘要.md`, and `沟通记录/完整沟通记录-2026-08-12.md`. Run:

```bash
python3 00_总览/工具/project_mgmt.py validate-structure
```

from the customer-management repository root and require zero ERROR.

- [ ] **Step 8: Commit Task 5 and perform completion audit**

```bash
git add scripts/reconcile-release-readiness.mjs package.json docs/开发记录.md test/orchestration/release-readiness-reconciliation.test.mjs
git commit -m "fix: reconcile production release readiness"
git status --short
```

Audit every design acceptance criterion against fresh tests, live API/D1 evidence, process IDs, and zero-side-effect counters before declaring completion.

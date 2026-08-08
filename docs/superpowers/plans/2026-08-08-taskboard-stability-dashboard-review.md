# Taskboard Stability and Dashboard Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a reproducible test baseline, complete an evidence-backed orchestration review, fix the currently confirmed version-field regression, and align the Operations Dashboard with the approved Codex Desktop two-column design without changing business semantics.

**Architecture:** Keep ClickUp, D1/SQLite, Git/GitHub, and the orchestration state machines as the existing sources of truth. First make the toolchain and known regression deterministic, then audit each real orchestration path and stop for a plan amendment if new P0/P1 findings require code changes. Implement the dashboard as a responsive composition of existing data components plus one shared dialog shell, with request sequencing in `Dashboard` preventing stale refresh/detail responses.

**Tech Stack:** Node.js 22.5+, pnpm, React 19, TypeScript 7, Vite 8, Node test runner, SQLite/D1, plain CSS using the existing Taskboard tokens.

## Global Constraints

- This is a personal local-first control console; do not add enterprise multi-user architecture.
- `main` is the default stable task baseline; `staging` is a Candidate test channel, never the default task branch source.
- UI scope is only the Operations Dashboard and dialogs opened from it.
- Preserve all current backend APIs, data meanings, permissions, and external side-effect boundaries unless an evidence-backed P0/P1 finding requires an approved plan amendment.
- Approved wide layout: main column = release actions + activity; side column = pipeline + version progress.
- Reuse `web/src/styles.css` tokens and the existing dialog vocabulary; do not add a UI framework or a second theme.
- Do not write to production ClickUp, GitHub, deployment environments, or production data during automated verification.
- Every completion claim requires fresh command output; known failures may not be silently ignored.

---

## File Map

- `package.json`: authoritative pnpm declaration and reproducible check scripts.
- `pnpm-lock.yaml`: authoritative dependency lock.
- `pnpm-workspace.yaml`: approved native-build policy for esbuild/workerd.
- `package-lock.json`: remove after pnpm is established as the only package manager.
- `README.md`: installation and verification commands aligned with pnpm.
- `test/orchestration/version-assignment.test.mjs`: ClickUp relationship-field contract.
- `orchestration/application/version-assignment.mjs`: version relationship write behavior; change only if the corrected tests expose a real defect.
- `orchestration/application/version-gate.mjs`: version relationship read behavior; change only if the review exposes a real defect.
- `docs/superpowers/reviews/2026-08-08-taskboard-orchestration-review.md`: evidence-backed review report and remediation gate.
- `web/src/components/dashboard/Dashboard.tsx`: request sequencing, responsive page composition, and dialog routing.
- `web/src/components/dashboard/DashboardDialog.tsx`: shared accessible modal shell for dashboard details and controls.
- `web/src/components/dashboard/DetailDrawer.tsx`: convert content from an independent drawer shell into dialog body content.
- `web/src/components/dashboard/ReleaseActions.tsx`: approved release-action row presentation and dialog trigger callback.
- `web/src/components/dashboard/PipelineOverview.tsx`: compact side-column pipeline rows.
- `web/src/components/dashboard/VersionProgress.tsx`: compact side-column version rows.
- `web/src/components/dashboard/ActivityFeed.tsx`: main-column activity rows.
- `web/src/components/dashboard/dashboard.css`: approved Codex Desktop layout, responsive behavior, dark mode, and dialog styling.
- `test/dashboard-components.test.mjs`: structural component and layout contracts.
- `test/dashboard-refresh.test.mjs`: request-sequencing and stale-response regression contracts.
- `test/dashboard-dialog.test.mjs`: modal focus, Escape, close, and trigger-return contracts.
- `docs/superpowers/reviews/2026-08-08-taskboard-dashboard-verification.md`: final command and screenshot evidence.

---

### Task 1: Make pnpm the single reproducible toolchain

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Keep: `pnpm-lock.yaml`
- Keep: `pnpm-workspace.yaml`
- Delete: `package-lock.json`

**Interfaces:**
- Produces: `pnpm check` as the single full verification entrypoint.
- Produces: `pnpm test:orchestration` and `pnpm test:dashboard` as deterministic focused suites used by later tasks.

- [ ] **Step 1: Add a failing package-manager contract test**

Create `test/package-manager-contract.test.mjs`:

```js
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("pnpm is the only documented and locked package manager", () => {
  assert.match(pkg.packageManager, /^pnpm@/);
  assert.equal(existsSync(new URL("../pnpm-lock.yaml", import.meta.url)), true);
  assert.equal(existsSync(new URL("../package-lock.json", import.meta.url)), false);
  assert.equal(pkg.scripts.check, "pnpm typecheck && pnpm build && pnpm test");
});
```

- [ ] **Step 2: Run the contract and verify the current mixed state fails**

Run: `node --test test/package-manager-contract.test.mjs`  
Expected: FAIL because `packageManager` is absent, `package-lock.json` exists, and `check` shells out to npm.

- [ ] **Step 3: Declare pnpm and remove nested npm usage**

In `package.json`:

```json
{
  "packageManager": "pnpm@11.16.0",
  "scripts": {
    "check": "pnpm typecheck && pnpm build && pnpm test",
    "test:orchestration": "node --test test/orchestration/*.test.mjs",
    "test:dashboard": "node --test test/dashboard-*.test.mjs test/orchestration/dashboard*.test.mjs"
  }
}
```

Replace the two remaining nested `npm run build:web` script calls with `pnpm build:web`. Update README commands from `npm install` / `npm run` to `pnpm install` / `pnpm`. Delete `package-lock.json`; do not regenerate dependencies.

- [ ] **Step 4: Verify dependency and command consistency**

Run:

```bash
node --test test/package-manager-contract.test.mjs
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

Expected: all commands exit 0; Vite may emit its existing chunk-size warning but no build error.

- [ ] **Step 5: Commit the toolchain baseline**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml README.md test/package-manager-contract.test.mjs
git add -u package-lock.json
git commit -m "build: standardize taskboard on pnpm"
```

---

### Task 2: Correct the target-version relationship regression tests

**Files:**
- Modify: `test/orchestration/version-assignment.test.mjs`
- Modify only if needed: `orchestration/application/version-assignment.mjs`
- Modify only if needed: `orchestration/application/version-gate.mjs`

**Interfaces:**
- Consumes: ClickUp relationship write shape `{ add: string[], rem: string[] }`.
- Produces: `targetVersionName(value): string | null` for string, object, and relationship-array reads.

- [ ] **Step 1: Update the three stale assertions to the real ClickUp contract**

Change the captured field-write assertions to:

```js
assert.deepEqual(updates[0].value, { add: ["v-1.0.3"], rem: [] });
assert.deepEqual(updates[0].value, { add: ["new-1.0.4"], rem: [] });
assert.deepEqual(updates[0].value, { add: ["v-1.0.4"], rem: [] });
```

Add a read-shape case:

```js
test("assignment keeps an existing relationship target version", async () => {
  const task = taskFixture({ targetVersion: [{ id: "v-1.0.3", name: "1.0.3" }] });
  const result = await assignTaskVersion(makeInput({ task }));
  assert.equal(result.versionName, "1.0.3");
  assert.equal(result.assigned, false);
});
```

- [ ] **Step 2: Run the focused tests**

Run:

```bash
node --test test/orchestration/version-assignment.test.mjs test/orchestration/version-gate.test.mjs
```

Expected: PASS. If the added relationship-read test fails, make the smallest correction in `targetVersionName`; do not alter version sequencing.

- [ ] **Step 3: Run the complete focused orchestration set from the baseline review**

Run:

```bash
node --test \
  test/orchestration/acceptance.test.mjs \
  test/orchestration/analyzer.test.mjs \
  test/orchestration/developer.test.mjs \
  test/orchestration/version-assignment.test.mjs \
  test/orchestration/version-gate.test.mjs \
  test/orchestration/clickup-snapshot.test.mjs \
  test/orchestration/clickup-poller.test.mjs \
  test/orchestration/dashboard.test.mjs \
  test/dashboard-api.test.mjs
```

Expected: 0 failures; this replaces the recorded 73/76 baseline.

- [ ] **Step 4: Commit the corrected contract**

```bash
git add test/orchestration/version-assignment.test.mjs orchestration/application/version-assignment.mjs orchestration/application/version-gate.mjs
git commit -m "test: align version assignment with ClickUp relationships"
```

---

### Task 3: Perform the evidence-backed orchestration review

**Files:**
- Create: `docs/superpowers/reviews/2026-08-08-taskboard-orchestration-review.md`
- Read: `cloud/src/clickup-poller.mjs`
- Read: `orchestration/ai/{analyzer,developer,acceptance}.mjs`
- Read: `orchestration/application/*.mjs`
- Read: `orchestration/domain/*.mjs`
- Read: `orchestration/persistence/*.mjs`
- Read: `orchestration/runner/*.mjs`
- Read: `orchestration/git/*.mjs`
- Read: `scripts/orchestrator.mjs`
- Read: `server/app.mjs`

**Interfaces:**
- Produces: one review row per verified finding with `ID`, `priority`, `path`, `evidence`, `impact`, `verification`, and `remediation`.
- Produces: an explicit `P0/P1 remediation gate` deciding whether this plan may proceed unchanged.

- [ ] **Step 1: Write the report skeleton with fixed operation paths**

Use these sections, each tracing entry → decision → side effect → observable result → recovery:

```markdown
## A. Inbox and external-task admission
## B. Analysis and waiting-for-information recovery
## C. Development worktree, commit, and PR creation
## D. Testing and acceptance rejection/retry
## E. Version assignment, integration, Candidate, and release
## F. Polling idempotency, leases, restart, and stale jobs
## G. Dashboard read model and control mutations
## H. Server shutdown, secrets, and local-network boundary
## Findings
## P0/P1 remediation gate
```

- [ ] **Step 2: Run the focused orchestration suite and record exact output**

Run: `pnpm test:orchestration`  
Record command, Node version, pnpm version, duration, pass/fail count, and every failing test in the report. Do not summarize failures as “mostly passing.”

- [ ] **Step 3: Verify branch and PR routing from code and tests**

Run:

```bash
node --test test/orchestration/worktree-runner.test.mjs test/orchestration/pr.test.mjs test/orchestration/git-merge.test.mjs
rg -n "baseRef|versionBranch|staging|createWorktree|createPullRequest" cloud/src orchestration scripts test/orchestration
```

Record whether each independent task starts from `main`/frozen baseline, whether PR base is `version/<target>`, and whether any path treats `staging` as a development baseline.

- [ ] **Step 4: Verify idempotency and recovery paths**

Run:

```bash
node --test \
  test/orchestration/clickup-poller.test.mjs \
  test/orchestration/d1-event-store.test.mjs \
  test/orchestration/dispatch-command.test.mjs \
  test/orchestration/failure-handler.test.mjs \
  test/orchestration/mvp-e2e.test.mjs
```

For every failure or ambiguous path, cite exact file and line in the report before assigning P0–P3.

- [ ] **Step 5: Apply the P0/P1 remediation gate**

If no new P0/P1 finding exists, write:

```markdown
Gate result: PASS — Tasks 4–8 may proceed without changing business semantics.
```

If any P0/P1 finding exists, write:

```markdown
Gate result: STOP — implementation plan amendment required before Dashboard work.
```

Then stop execution and amend this plan with exact failing tests and files; do not improvise an unreviewed fix.

- [ ] **Step 6: Commit the review evidence**

```bash
git add docs/superpowers/reviews/2026-08-08-taskboard-orchestration-review.md
git commit -m "docs: record taskboard orchestration review"
```

---

### Priority hotfix: stop development-status flapping

The user approved this hotfix before the mandatory remediation block after observing a task repeatedly moving between `待开发` and `开发中`.

**Files:**
- Modify: `cloud/src/clickup-poller.mjs`
- Modify: `orchestration/ai/developer.mjs`
- Modify: `test/orchestration/clickup-poller.test.mjs`
- Modify: `test/orchestration/developer.test.mjs`

**Required regression contracts:**
- A normal failed `develop` runner job remains blocked across aggregate-version changes and is not automatically re-enqueued.
- An explicit ClickUp status change from `待开发` to `开发中` clears that normal failure block and queues exactly one manual retry.
- Existing `waiting_version`, `needs_human`, and `needs_info` parking/resume behavior remains unchanged.
- Development rollback posts a concise diagnostic ClickUp comment, including for the top-level exception path, while redacting common secret forms.

**Commands:**

```bash
node --test test/orchestration/developer.test.mjs test/orchestration/clickup-poller.test.mjs
pnpm test:orchestration
```

---

### Mandatory remediation block: resolve Task 3 P0/P1 before Tasks 4–8

Task 3 gate is `STOP`. None of Tasks 4–8 may start until every remediation below is implemented in order, its named regression command passes, an evidence review confirms the finding is closed, and the user explicitly re-approves reopening Dashboard work. Product-code execution of this block also requires the user's approval of this amended plan; the amendment itself does not authorize the fixes.

#### Task 3R1: Stop false publishing and preserve an immutable Candidate (ORCH-P0-001)

**Files:**
- Modify: `scripts/orchestrator.mjs`
- Modify: `orchestration/application/release-commands.mjs`
- Modify: `orchestration/release/version-aggregator.mjs`
- Modify: `orchestration/git/merge.mjs`
- Create: `test/orchestration/release-coordinator.test.mjs`
- Modify: `test/orchestration/release-commands.test.mjs`
- Modify: `test/orchestration/version-aggregator.test.mjs`
- Modify: `test/orchestration/git-merge.test.mjs`

**Required regression contracts:**
- A version cannot become `published` when the task PRs have not been integrated into `version/<target>`, no immutable Candidate commit is frozen, the deployer is missing/placeholder, version-level regression evidence is absent, or remote deployment readback is not confirmed.
- The frozen manifest records the exact Candidate commit, version branch, included task PR heads, artifact identity, and regression evidence.
- Failure before confirmed publication must not close the PR or remove local worktrees/local branches/remote branch refs.
- Successful cleanup occurs only after the exact frozen Candidate is confirmed deployed and published; the PR is closed, while local worktree/local branch/remote branch refs may then be removed under the recorded cleanup result.

**Commands:**

```bash
node --test \
  test/orchestration/release-coordinator.test.mjs \
  test/orchestration/release-commands.test.mjs \
  test/orchestration/version-aggregator.test.mjs \
  test/orchestration/git-merge.test.mjs \
  test/orchestration/web-adapter.test.mjs
rg -n "mergeTaskPrToVersionBranch|candidateCommit|regressionEvidence|removeTaskWorktree|closeTaskPullRequest|deleteRemoteTaskBranch" \
  scripts/orchestrator.mjs orchestration test/orchestration
```

#### Task 3R2: Normalize ClickUp relationship values in development order (ORCH-P1-002)

**Files:**
- Modify: `orchestration/application/development-order.mjs`
- Modify: `test/orchestration/development-order.test.mjs`

**Required regression contract:** two separately allocated ClickUp `list_relationship` arrays that refer to the same version must be treated as the same version, and an unfinished higher-priority sibling must block development.

**Command:**

```bash
node --test test/orchestration/development-order.test.mjs test/orchestration/version-gate.test.mjs
```

#### Task 3R3: Enforce outbox preconditions and remote confirmation (ORCH-P1-003)

**Files:**
- Modify: `orchestration/clickup/outbox.mjs`
- Modify: `orchestration/clickup/client.mjs`
- Modify: `test/orchestration/clickup-outbox.test.mjs`
- Modify: `test/orchestration/clickup-client.test.mjs`

**Required regression contracts:**
- A remote value that no longer equals `expected_before` must not be overwritten or marked confirmed.
- A successful write is confirmed only after normalized remote readback equals the target.
- A transport failure with unknown outcome is reconciled before retry; it is not blindly replayed.

**Command:**

```bash
node --test test/orchestration/clickup-outbox.test.mjs test/orchestration/clickup-client.test.mjs
```

#### Task 3R4: Drain jobs and recover only safe leases (ORCH-P1-004)

**Files:**
- Modify: `scripts/orchestrator.mjs`
- Modify: `orchestration/runner/codex-runner.mjs`
- Modify: `orchestration/persistence/d1-runner-jobs.mjs`
- Create: `test/orchestration/orchestrator-lifecycle.test.mjs`
- Modify: `test/orchestration/codex-runner.test.mjs`
- Modify: `test/orchestration/runner-jobs.test.mjs`

**Required regression contracts:**
- SIGINT/SIGTERM stops new claims, cancels or drains active Codex runs, awaits job settlement, closes Dashboard/Miniflare, and clears the polling interval.
- Restart never resets a live, unexpired claim; only expired/reconciled jobs can be requeued.
- A stale fencing token is checked before every Git/GitHub/ClickUp side-effect boundary, not only at result completion.

**Command:**

```bash
node --test \
  test/orchestration/orchestrator-lifecycle.test.mjs \
  test/orchestration/codex-runner.test.mjs \
  test/orchestration/runner-jobs.test.mjs
```

#### Task 3R5: Authorize standalone loopback mutations (ORCH-P1-005)

**Files:**
- Modify: `orchestration/dashboard/http-server.mjs`
- Modify: `scripts/orchestrator.mjs`
- Modify: `server/app.mjs`
- Modify: `test/orchestration/dashboard-http.test.mjs`
- Modify: `test/orchestration/control-http.test.mjs`
- Modify: `test/server.test.mjs`

**Required regression contracts:**
- Unauthenticated direct loopback `POST .../publish` and `PUT .../control` requests are rejected and create no mutation/control write.
- The main server's loopback-validated proxy can authorize those mutations with a per-process secret that is not returned by read APIs.
- Valid authenticated requests preserve current success/error semantics. Browser cross-origin exploitability is environment-dependent and is not the acceptance criterion; the invariant is authorization of every mutation request.

**Command:**

```bash
node --test \
  test/orchestration/dashboard-http.test.mjs \
  test/orchestration/control-http.test.mjs \
  test/server.test.mjs
```

#### Task 3R6: Restore the orchestration regression gate

**Files:**
- Modify: `test/orchestration/mvp-e2e.test.mjs`

**Required regression contract:** the failed-development scenario asserts the intended final `ready_for_development` state and exact four-event/version sequence after external admission, start, and rollback; it must not require aggregate version zero.

**Commands:**

```bash
node --test --test-name-pattern='failed development blocks without advancing the task' \
  test/orchestration/mvp-e2e.test.mjs
pnpm test:orchestration
```

#### Mandatory evidence review and human re-approval checkpoint

After Tasks 3R1–3R6, rerun every command above plus:

```bash
pnpm typecheck
pnpm build
pnpm test:orchestration
git diff --check
```

Update `docs/superpowers/reviews/2026-08-08-taskboard-orchestration-review.md` with the exact outputs and one closure row per P0/P1. An independent review must confirm there is no remaining P0/P1 and that the release path has no placeholder external side effect. Then stop and ask the user to review the evidence and explicitly approve reopening Tasks 4–8. Silence, test success, or reviewer approval alone does not reopen the gate.

---

### Task 4: Add stale-response protection to Dashboard loading

**Files:**
- Create: `test/dashboard-refresh.test.mjs`
- Modify: `web/src/components/dashboard/Dashboard.tsx`

**Interfaces:**
- Produces: only the most recently started dashboard request may update payload, control, error, refreshing, and timestamp state.
- Produces: only the current detail request may update dialog detail state.

- [ ] **Step 1: Write source-contract tests for request generations**

Create `test/dashboard-refresh.test.mjs` asserting the component contains two monotonic refs and generation checks:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../web/src/components/dashboard/Dashboard.tsx", import.meta.url), "utf8");

test("dashboard refresh ignores stale responses", () => {
  assert.match(source, /const loadGenerationRef = useRef\(0\)/);
  assert.match(source, /const generation = \+\+loadGenerationRef\.current/);
  assert.match(source, /generation !== loadGenerationRef\.current/);
});

test("dashboard detail ignores stale responses", () => {
  assert.match(source, /const detailGenerationRef = useRef\(0\)/);
  assert.match(source, /const generation = \+\+detailGenerationRef\.current/);
  assert.match(source, /generation !== detailGenerationRef\.current/);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/dashboard-refresh.test.mjs`  
Expected: FAIL because generation refs do not exist.

- [ ] **Step 3: Implement the minimal generation guards**

In `Dashboard.tsx`, add:

```ts
const loadGenerationRef = useRef(0);
const detailGenerationRef = useRef(0);
```

At each load/detail start, capture `const generation = ++...current`; before every state write in success, failure, and finally, return when the generation is stale. Preserve the previous successful payload on background refresh failure and show the error alongside stale data.

- [ ] **Step 4: Verify focused UI and type contracts**

Run:

```bash
node --test test/dashboard-refresh.test.mjs test/dashboard-components.test.mjs test/dashboard-api.test.mjs
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit request consistency**

```bash
git add web/src/components/dashboard/Dashboard.tsx test/dashboard-refresh.test.mjs
git commit -m "fix: ignore stale dashboard responses"
```

---

### Task 5: Replace the dashboard drawer with the shared dialog shell

**Files:**
- Create: `web/src/components/dashboard/DashboardDialog.tsx`
- Modify: `web/src/components/dashboard/DetailDrawer.tsx`
- Modify: `web/src/components/dashboard/Dashboard.tsx`
- Create: `test/dashboard-dialog.test.mjs`
- Modify: `test/dashboard-components.test.mjs`

**Interfaces:**
- Produces: `DashboardDialog({ title, labelledBy, triggerRef, busy, closeDisabled, onClose, children, footer })`.
- `DetailDrawer` becomes detail-body rendering inside `DashboardDialog`; its task/version data interface remains unchanged.

- [ ] **Step 1: Write the dialog behavior contract**

Create `test/dashboard-dialog.test.mjs` with source assertions for:

```js
assert.match(source, /role="dialog"/);
assert.match(source, /aria-modal="true"/);
assert.match(source, /event\.key === "Escape"/);
assert.match(source, /triggerRef\.current\?\.focus\(\)/);
assert.match(source, /querySelectorAll<HTMLElement>/);
assert.match(source, /event\.key === "Tab"/);
```

Update `test/dashboard-components.test.mjs` to require `<DashboardDialog` and reject the old independent `.detail-drawer` shell.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test test/dashboard-dialog.test.mjs test/dashboard-components.test.mjs`  
Expected: FAIL because `DashboardDialog.tsx` does not exist and `DetailDrawer` still owns the fixed drawer shell.

- [ ] **Step 3: Implement the shared shell**

Implement a portal-based dialog using the existing issue-dialog structure and CSS class vocabulary. On open, focus the close button or first focusable element; trap Tab/Shift+Tab; close on Escape only when `closeDisabled` is false; return focus to the initiating activity/version/control/release element after close.

- [ ] **Step 4: Route all Dashboard entry points through the dialog**

Use one discriminated state:

```ts
type DialogState =
  | { kind: "task"; id: string; trigger: HTMLElement }
  | { kind: "version"; id: string; trigger: HTMLElement }
  | { kind: "release"; id: string; trigger: HTMLElement }
  | { kind: "control"; trigger: HTMLElement }
  | null;
```

Pass click events from activity, version, release, and control triggers so focus can return exactly. Preserve existing release/control mutation confirmation and error semantics.

- [ ] **Step 5: Verify dialog contracts and typecheck**

Run:

```bash
node --test test/dashboard-dialog.test.mjs test/dashboard-components.test.mjs test/project-automation-settings.test.mjs
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the dialog unification**

```bash
git add web/src/components/dashboard/DashboardDialog.tsx web/src/components/dashboard/DetailDrawer.tsx web/src/components/dashboard/Dashboard.tsx test/dashboard-dialog.test.mjs test/dashboard-components.test.mjs
git commit -m "refactor: unify dashboard dialogs"
```

---

### Task 6: Implement the approved two-column information architecture

**Files:**
- Modify: `web/src/components/dashboard/Dashboard.tsx`
- Modify: `web/src/components/dashboard/ReleaseActions.tsx`
- Modify: `web/src/components/dashboard/PipelineOverview.tsx`
- Modify: `web/src/components/dashboard/VersionProgress.tsx`
- Modify: `web/src/components/dashboard/ActivityFeed.tsx`
- Modify: `test/dashboard-components.test.mjs`

**Interfaces:**
- Produces DOM regions `.dashboard-main-column` and `.dashboard-side-column`.
- Main column order: `ReleaseActions`, `ActivityFeed`.
- Side column order: `PipelineOverview`, `VersionProgressList`.

- [ ] **Step 1: Write the approved-order structural test**

Add assertions that `Dashboard.tsx` matches:

```js
assert.match(
  dashboardSource,
  /className="dashboard-main-column"[\s\S]*?<ReleaseActions[\s\S]*?<ActivityFeed/,
);
assert.match(
  dashboardSource,
  /className="dashboard-side-column"[\s\S]*?<PipelineOverview[\s\S]*?<VersionProgressList/,
);
```

Add assertions that section components use compact row/list classes and no nested generic card wrapper.

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/dashboard-components.test.mjs`  
Expected: FAIL because the current dashboard renders all four sections sequentially.

- [ ] **Step 3: Implement the semantic layout structure**

Keep component data and callbacks unchanged while adding:

```tsx
<div className="dashboard-workspace">
  <main className="dashboard-main-column">
    <ReleaseActions ... />
    <ActivityFeed ... />
  </main>
  <aside className="dashboard-side-column" aria-label="研发概览">
    <PipelineOverview ... />
    <VersionProgressList ... />
  </aside>
</div>
```

Do not change counts, progress calculations, object IDs, or release eligibility.

- [ ] **Step 4: Convert child markup to compact rows**

- `ActivityFeed`: time, object link, summary/result; entire row remains a button.
- `VersionProgress`: name, compact track, percentage/status, chevron; entire row remains a button.
- `PipelineOverview`: one flat row per status with count and semantic accent marker.
- `ReleaseActions`: flat actionable row; empty state remains visible but visually quiet.

- [ ] **Step 5: Verify component contracts**

Run:

```bash
node --test test/dashboard-components.test.mjs test/dashboard-api.test.mjs test/dashboard-view.test.mjs
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the information architecture**

```bash
git add web/src/components/dashboard test/dashboard-components.test.mjs
git commit -m "feat: align dashboard information architecture"
```

---

### Task 7: Apply Codex Desktop styling and responsive behavior

**Files:**
- Modify: `web/src/components/dashboard/dashboard.css`
- Modify: `test/dashboard-components.test.mjs`

**Interfaces:**
- Produces responsive thresholds `880px` and `620px`.
- Consumes only existing global CSS tokens; no new hard-coded theme palette.

- [ ] **Step 1: Add CSS contract assertions**

Require:

```js
assert.match(css, /\.dashboard-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+320px/s);
assert.match(css, /@media\s*\(max-width:\s*880px\)/);
assert.match(css, /@media\s*\(max-width:\s*620px\)/);
assert.match(css, /\.dashboard-dialog-backdrop/);
assert.match(css, /var\(--dialog-shadow\)/);
assert.doesNotMatch(css, /#[0-9a-fA-F]{6}/);
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/dashboard-components.test.mjs`  
Expected: FAIL on the approved grid and hard-coded-color contract.

- [ ] **Step 3: Rewrite Dashboard CSS around flat sections**

Use:

```css
.dashboard-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 28px;
  min-height: 0;
}

.dashboard-side-column {
  border-left: var(--border-hairline) solid var(--border);
  padding-left: 28px;
}
```

Use separators, hover surfaces, 5–9px radii, 11–13px text, and existing status tokens. Remove section gradients, colored header dots used only as decoration, nested card shadows, and duplicated drawer styling.

- [ ] **Step 4: Implement responsive and dark-mode-safe behavior**

At `<= 880px`, switch to one column and remove the side border. At `<= 620px`, reduce page padding and allow row metadata to wrap without horizontal page scrolling. Do not add dark-mode overrides when existing tokens already provide the correct values.

- [ ] **Step 5: Build and verify CSS contracts**

Run:

```bash
node --test test/dashboard-components.test.mjs test/input-focus-chrome.test.mjs
pnpm typecheck
pnpm build
```

Expected: PASS; no CSS parse errors.

- [ ] **Step 6: Commit the visual alignment**

```bash
git add web/src/components/dashboard/dashboard.css test/dashboard-components.test.mjs
git commit -m "style: align dashboard with Codex Desktop"
```

---

### Task 8: Run full regression and produce visual evidence

**Files:**
- Create: `docs/superpowers/reviews/2026-08-08-taskboard-dashboard-verification.md`
- Create: `docs/superpowers/reviews/assets/dashboard-wide-light.png`
- Create: `docs/superpowers/reviews/assets/dashboard-narrow-light.png`
- Create: `docs/superpowers/reviews/assets/dashboard-wide-dark.png`
- Create: `docs/superpowers/reviews/assets/dashboard-task-dialog.png`

**Interfaces:**
- Produces a final evidence report mapping each acceptance criterion to command output or screenshot.

- [ ] **Step 1: Run the complete project check without interruption**

Run: `pnpm check`  
Expected: exit 0. Record Node/pnpm versions, duration, test count, pass count, fail count, skipped count, and build warnings.

If any test fails, do not create a success report. Classify it against the Task 3 baseline, fix an in-scope regression with a failing test first, or stop for a plan amendment.

- [ ] **Step 2: Start an isolated verification server**

Run:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 CODEX_TASKBOARD_PORT=47824 pnpm start
```

Use port `47824` so verification does not disturb the user's running `47823` service.

- [ ] **Step 3: Capture four required visual states**

Using Chrome headless or the in-app browser, capture:

- 1440×1000 light Dashboard.
- 744×1224 light Dashboard.
- 1440×1000 dark Dashboard.
- 1440×1000 task-detail dialog open.

Store the screenshots at the exact asset paths listed above. Inspect each image for clipping, page-level horizontal scrolling, inconsistent tokens, obscured controls, and modal focus visibility.

- [ ] **Step 4: Verify dialog keyboard behavior manually**

For task, version, control, and release dialogs:

1. Open from its trigger.
2. Press Tab and Shift+Tab through all focusable controls.
3. Confirm focus stays inside.
4. Press Escape where allowed.
5. Confirm focus returns to the exact trigger.
6. Confirm pending destructive/action dialogs cannot be dismissed incorrectly.

Record pass/fail for all four dialog kinds.

- [ ] **Step 5: Write the final verification report**

Include:

```markdown
## Environment
## Full check output
## Focused orchestration output
## Responsive screenshots
## Dialog keyboard matrix
## Acceptance-criteria mapping
## Known residual risks
## Rollback commits
```

Every residual risk must include impact and next action; write `None` only when the corresponding checks prove none remain.

- [ ] **Step 6: Validate customer-project structure**

From `/Users/yuantao/Documents/customer-projects-management` run:

```bash
python3 00_总览/工具/project_mgmt.py validate-structure
```

Expected: exit 0 with no `ERROR`.

- [ ] **Step 7: Commit verification evidence**

```bash
git add docs/superpowers/reviews/2026-08-08-taskboard-dashboard-verification.md docs/superpowers/reviews/assets/
git commit -m "docs: verify taskboard stability and dashboard"
```

---

## Execution Checkpoints

1. After Task 3, stop if the P0/P1 remediation gate is `STOP`; amend and re-approve the implementation plan before code changes continue.
2. After Task 5, manually show the unified dialog behavior before changing the page layout.
3. After Task 7, show wide and narrow screenshots before the final full regression.
4. Task 8 may claim completion only with `pnpm check` exit 0 and the recorded visual/keyboard evidence.

# Staging Failure Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent already-merged tasks from failing when their version branch advances, and prevent staging infrastructure failures from being repeatedly routed to product development.

**Architecture:** Git integration will prove containment against an isolated refreshed remote-version ref and return that ref's current SHA as the Candidate. Staging failures will be persisted with a deterministic redacted fingerprint and move the task to the existing `acceptance_rejected` external status without consuming product rework; an explicit retry will resume the accepted Candidate through `retry_staging`, never create a develop job. The existing comment/media product-rework path remains unchanged.

**Tech Stack:** Node.js ESM, `node:test`, Git CLI, D1/SQLite migrations, ClickUp polling, Miniflare orchestration tests.

## Global Constraints

- Never expose ClickUp tokens, comment credentials, deployment secrets, or raw unredacted errors.
- Never deploy production or submit App Review.
- Web and every required iOS App/TestFlight gate must still pass before `ready_for_test`.
- Product rework continues to include the latest 12 ClickUp comments and images from the same window.
- All production changes follow RED → GREEN TDD and focused tests precede the full orchestration suite.

---

### Task 1: Prove merged PR containment against the current remote version

**Files:**
- Modify: `orchestration/git/merge.mjs`
- Test: `test/orchestration/git-merge.test.mjs`

**Interfaces:**
- Consumes: `fetchAndMergeTaskPullRequest({ repoPath, repository, taskId, pullRequest, versionBranch, run })`.
- Produces: for a contained merged PR, `{ merged: true, taskHead, candidateCommit: <current remote version SHA>, alreadyMerged: true }`.

- [ ] **Step 1: Write failing merged-ancestor tests**

Add real temporary-repository tests for: merge commit equals remote HEAD; merge commit is an ancestor of a later remote HEAD; PR head or merge commit absent from the refreshed version history. Assert the ancestor case returns the later remote HEAD as `candidateCommit`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/orchestration/git-merge.test.mjs`

Expected: the later-HEAD case fails with `merged PR commit is not the current remote version branch`.

- [ ] **Step 3: Implement the minimal containment proof**

Fetch `refs/heads/<versionBranch>` into an isolated `refs/taskboard/base/<versionBranch>` ref, validate both GitHub SHAs, and run:

```js
git(repoPath, ["merge-base", "--is-ancestor", pr.headRefOid, fetchedBase], run);
git(repoPath, ["merge-base", "--is-ancestor", pr.mergeCommit.oid, fetchedBase], run);
git(repoPath, ["rev-parse", fetchedBase], run);
```

Fail closed on any failed fetch/validation/containment command. Return the refreshed ref SHA as `candidateCommit`.

- [ ] **Step 4: Verify GREEN and regression safety**

Run: `node --test test/orchestration/git-merge.test.mjs`

Expected: all Git merge tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add orchestration/git/merge.mjs test/orchestration/git-merge.test.mjs
git commit -m "fix: accept contained merged pull requests"
```

---

### Task 2: Persist staging ownership and failure fingerprints

**Files:**
- Create: `cloud/migrations/0012_staging_failure_ownership.sql`
- Modify: `orchestration/persistence/migrations.mjs`
- Modify: `orchestration/application/staging-coordinator.mjs`
- Test: `test/orchestration/staging-coordinator.test.mjs`
- Test: `test/orchestration/migration-runner.test.mjs`

**Interfaces:**
- Produces staging deployment fields `failure_owner`, `failure_classification`, and `failure_fingerprint`.
- Produces result `{ status: "failed", classification: "staging_infrastructure", stage, error, fingerprint, repeated }` for stage failures.

- [ ] **Step 1: Write failing persistence and transition tests**

Cover a merge failure and a TestFlight failure. Assert each:

```js
assert.equal(result.classification, "staging_infrastructure");
assert.equal((await loadAggregate(db, "task", taskId)).state, "acceptance_rejected");
assert.equal(await productReworkFailureCount(db, taskId), 0);
assert.match(comment, /产品开发已完成，当前为提测基础设施故障/);
```

Run the same Candidate/stage/error twice through an explicit staging retry and assert the second record has the same fingerprint and `repeated === true` without a product-development transition.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/orchestration/staging-coordinator.test.mjs test/orchestration/migration-runner.test.mjs`

Expected: current code returns `staging_failure`, increments shared rework, and transitions to `ready_for_development`.

- [ ] **Step 3: Add the migration**

Extend `staging_deployments` with nullable text columns:

```sql
ALTER TABLE staging_deployments ADD COLUMN failure_owner TEXT
  CHECK (failure_owner IS NULL OR failure_owner IN ('product_rework', 'staging_infrastructure'));
ALTER TABLE staging_deployments ADD COLUMN failure_classification TEXT;
ALTER TABLE staging_deployments ADD COLUMN failure_fingerprint TEXT;
CREATE INDEX idx_staging_failure_fingerprint
  ON staging_deployments (task_id, candidate_commit, failure_fingerprint, attempt DESC)
  WHERE status = 'failed' AND failure_fingerprint IS NOT NULL;
```

Register migration `0012_staging_failure_ownership.sql` in the migration sentinel test.

- [ ] **Step 4: Implement infrastructure failure handling**

In `staging-coordinator.mjs`, normalize and redact the error, hash
`taskId|candidateCommit-or-unknown|stage|staging_infrastructure|redactedError` with SHA-256, query prior identical failures, update the current attempt with ownership fields, and dispatch `acceptance_rejected` directly. Do not call `recordFailure`; staging faults must not consume product rework counters. Post a structured ClickUp comment that distinguishes first and repeated failures.

- [ ] **Step 5: Verify GREEN**

Run: `node --test test/orchestration/staging-coordinator.test.mjs test/orchestration/migration-runner.test.mjs`

Expected: all focused tests pass and no tested infrastructure failure reaches `ready_for_development`.

- [ ] **Step 6: Commit Task 2**

```bash
git add cloud/migrations/0012_staging_failure_ownership.sql orchestration/persistence/migrations.mjs orchestration/application/staging-coordinator.mjs test/orchestration/staging-coordinator.test.mjs test/orchestration/migration-runner.test.mjs
git commit -m "fix: isolate staging infrastructure failures"
```

---

### Task 3: Route explicit recovery back to staging, not development

**Files:**
- Modify: `orchestration/clickup/poller.mjs`
- Modify: `orchestration/application/task-command-handlers.mjs`
- Modify: `orchestration/domain/task-state.mjs`
- Modify: `orchestration/application/staging-coordinator.mjs`
- Test: `test/orchestration/clickup-poller.test.mjs`
- Test: `test/orchestration/staging-coordinator.test.mjs`
- Test: `test/orchestration/mvp-e2e.test.mjs`

**Interfaces:**
- Consumes: latest failed `staging_deployments.failure_owner === "staging_infrastructure"` for the task.
- Produces: `retry_staging`/`restage_task` command and a `stage_task` job reusing accepted PR, target version, platforms, and commit evidence; never a `develop` job.

- [ ] **Step 1: Write failing poller and end-to-end recovery tests**

Seed an `acceptance_rejected` task with a latest infrastructure-owned staging failure. Simulate the user moving ClickUp to 「待开发」 and assert the poller emits a staging retry command, creates no develop job, and the successful retry reaches `ready_for_test`. Retain the existing test proving a product acceptance rejection still creates a develop job and carries latest comments/images.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/orchestration/clickup-poller.test.mjs test/orchestration/mvp-e2e.test.mjs`

Expected: current poller emits `acceptance_rejected_to_develop` and queues development.

- [ ] **Step 3: Implement ownership-aware retry routing**

At the explicit rejection-to-development decision boundary, load the latest staging attempt. If its owner is `staging_infrastructure`, dispatch `retry_staging` and rebuild the stage job from persisted evidence; otherwise preserve the existing product-rework behavior. Unknown or incomplete evidence fails closed with a comment and no job.

- [ ] **Step 4: Preserve repeated-fingerprint blocking**

Before external deployment, compare the current retry fingerprint inputs with the previous failure. A retry may re-run after an explicit user action or changed Candidate/configuration, but it must never schedule development. If the exact fault recurs, return to `acceptance_rejected`, mark `repeated`, and require another explicit recovery action.

- [ ] **Step 5: Verify GREEN**

Run: `node --test test/orchestration/clickup-poller.test.mjs test/orchestration/staging-coordinator.test.mjs test/orchestration/mvp-e2e.test.mjs`

Expected: recovery resumes staging, product feedback behavior remains unchanged, and no automatic loop exists.

- [ ] **Step 6: Commit Task 3**

```bash
git add orchestration/clickup/poller.mjs orchestration/application/task-command-handlers.mjs orchestration/domain/task-state.mjs orchestration/application/staging-coordinator.mjs test/orchestration/clickup-poller.test.mjs test/orchestration/staging-coordinator.test.mjs test/orchestration/mvp-e2e.test.mjs
git commit -m "fix: resume staging failures without redevelopment"
```

---

### Task 4: Verification, documentation, service restart, and `86d3yebnh` recovery

**Files:**
- Modify: `docs/开发记录.md`
- Modify outside source repository per customer archive rules: `沟通记录/当前沟通.md`
- Modify outside source repository per customer archive rules: `沟通记录/交接摘要.md`

**Interfaces:**
- Produces: verified running orchestrator on `127.0.0.1:47824` and a single staging recovery for task `86d3yebnh`.

- [ ] **Step 1: Run static and full regression verification**

```bash
node --check orchestration/git/merge.mjs
node --check orchestration/application/staging-coordinator.mjs
node --check orchestration/clickup/poller.mjs
pnpm test:orchestration
git diff --check
```

Expected: zero failures and zero diff-check errors.

- [ ] **Step 2: Update development and customer records**

Record the root cause, ownership rules, tests, commits, and live recovery outcome in `docs/开发记录.md`, `沟通记录/当前沟通.md`, and `沟通记录/交接摘要.md`. Do not copy secrets or raw credential-bearing comments.

- [ ] **Step 3: Commit source documentation**

```bash
git add docs/开发记录.md
git commit -m "docs: record staging failure recovery"
```

- [ ] **Step 4: Restart only the orchestrator child**

Use the existing `.data/supervise-orchestrator.private.py` supervisor mechanism. Confirm the supervisor PID is unchanged, the child PID changes, `GET http://127.0.0.1:47824/health` (or the repository's existing health endpoint) returns HTTP 200, and Dashboard `http://127.0.0.1:47823` remains HTTP 200.

- [ ] **Step 5: Recover `86d3yebnh` once**

Verify PR #895 head and merge commit are ancestors of current `origin/version/v1.0.3`. Trigger only the ownership-aware staging recovery, then observe one stage job. Success requires Web and both enabled iOS/TestFlight gates before ClickUp becomes 「待测试」. Any real deployment failure must remain an infrastructure-owned rejection and must not create a develop job.

- [ ] **Step 6: Validate customer archive structure**

From the customer-management repository root run:

```bash
python3 00_总览/工具/project_mgmt.py validate-structure
```

Expected: zero `ERROR` entries.

- [ ] **Step 7: Final verification report**

Report exact focused/full test counts, service PIDs/HTTP status, task job/state evidence, and any external deployment blocker. Never claim deployment success before authoritative readback.


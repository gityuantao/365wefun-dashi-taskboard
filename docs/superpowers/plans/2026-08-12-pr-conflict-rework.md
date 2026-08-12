# PR Conflict Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically return version-branch merge conflicts to AI development with complete evidence, preserve exact iOS platform scope, update the original PR, and resume the all-App TestFlight path.

**Architecture:** The Git boundary produces typed conflict evidence. The staging coordinator persists that evidence as product rework and the poller routes the exact failed attempt into one development job. Platform scope is loaded from exact completed analysis when the ClickUp snapshot has no explicit platform field.

**Tech Stack:** Node.js ESM, D1/SQLite, Git/GitHub CLI, ClickUp poller, `node:test`.

## Global Constraints

- Do not manually edit task business code.
- Reuse PR #915 and PR #916; never create replacement PRs.
- No Candidate, deploy, TestFlight upload, or ready-for-test transition may occur while a merge conflict remains.
- iOS staging completion still requires every enabled App's authoritative TestFlight membership.
- Preserve historical attempts and acceptance evidence.
- Store only bounded, redacted conflict output.

---

### Task 1: Typed Git merge conflict evidence

**Files:**
- Modify: `orchestration/git/merge.mjs`
- Modify: `test/orchestration/git-merge.test.mjs`

**Interfaces:**
- `fetchAndMergeTaskPullRequest()` returns `classification: "merge_conflict"`, `conflictedPaths`, `versionBranch`, PR identity, task head, and bounded `error` when Git exits with a content conflict.

- [ ] Add a real temporary-repository test where stdout contains conflict details and stderr is empty.
- [ ] Run `node --test test/orchestration/git-merge.test.mjs` and verify the new assertion fails because `error` is empty and paths are absent.
- [ ] Parse `CONFLICT (...)` lines and unmerged-index paths, combine stdout/stderr, redact and bound the diagnostic, and preserve existing non-conflict failure behavior.
- [ ] Re-run the focused test and commit the independently working Git boundary.

### Task 2: Product-rework staging classification and prompt propagation

**Files:**
- Modify: `orchestration/application/staging-coordinator.mjs`
- Modify: `cloud/src/clickup-poller.mjs`
- Modify: `orchestration/ai/developer.mjs`
- Modify: `test/orchestration/staging-coordinator.test.mjs`
- Modify: `test/orchestration/clickup-poller.test.mjs`
- Modify: `test/orchestration/developer.test.mjs`

**Interfaces:**
- A merge conflict persists `failure_owner=product_rework`, `failure_classification=merge_conflict` and exact structured evidence.
- The exact rejection produces one `develop` job whose rework findings instruct the agent to update the original PR after merging the target version branch.

- [ ] Add a staging test proving conflict evidence persists, deploy calls stay at zero, and the aggregate becomes `acceptance_rejected` with exact evidence.
- [ ] Add a poller test proving the current explicit recovery queues one develop job, not `retry_staging`, and loads only the exact conflict attempt.
- [ ] Add a developer prompt test proving version branch, PR URL/number, paths, and same-PR instruction are present.
- [ ] Run the three suites and verify the new expectations fail for the current infrastructure classification/empty context.
- [ ] Implement the minimal typed routing and context propagation, then re-run the suites.
- [ ] Commit the conflict rework lifecycle.

### Task 3: Exact analysis platform continuity

**Files:**
- Modify: `orchestration/ai/analyzer.mjs` only if its result omits normalized platforms.
- Modify: `cloud/src/clickup-poller.mjs`
- Modify: `test/orchestration/analyzer.test.mjs`
- Modify: `test/orchestration/clickup-poller.test.mjs`
- Modify: `test/orchestration/mvp-e2e.test.mjs`

**Interfaces:**
- Exact completed analysis result exposes normalized `platforms`.
- `ensureStateJob()` prefers valid explicit snapshot platforms and otherwise uses exact-task analysis platforms for development, acceptance, and staging payloads.

- [ ] Add a regression where ClickUp platform field is empty but analysis concludes iOS.
- [ ] Verify RED: the resulting stage payload currently contains `[]`.
- [ ] Load and validate the exact analysis platforms without cross-task/history fallback.
- [ ] Verify the stage payload contains `["ios"]`, while explicit valid snapshot platforms remain authoritative.
- [ ] Run the related E2E and commit.

### Task 4: Runtime activation and live task recovery

**Files:**
- Modify: `docs/开发记录.md`
- Modify customer communication/audit records required by the root `AGENTS.md`.

**Interfaces:**
- Only the supervised child is restarted.
- Live recovery uses normal ClickUp state transitions and original PRs.

- [ ] Run focused suites, full `pnpm test:orchestration`, syntax checks, and `git diff --check`.
- [ ] Obtain independent read-only review and resolve every Critical/Important finding.
- [ ] Update tracked development documentation and commit.
- [ ] Restart only the orchestrator child; prove the supervisor PID is unchanged and ports 47823/47824 return 200.
- [ ] Move the two exact tasks through the normal explicit recovery boundary without deleting historical attempts.
- [ ] Verify each new development job contains current conflict evidence and uses PR #915/#916.
- [ ] Monitor until each original PR head changes, becomes integrable, acceptance passes, Candidate integration succeeds, and iOS all-App TestFlight evidence is authoritative.
- [ ] Record any external waiting state honestly; do not bypass or manually repair business code.

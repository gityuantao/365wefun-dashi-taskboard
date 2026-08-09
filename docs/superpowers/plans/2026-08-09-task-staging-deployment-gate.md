# Task Staging Deployment Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a task reaches ClickUp「待测试」only after its PR is merged, the target version branch is deployed to staging, and staging readback proves the task commit is running; failures return to「待开发」with actionable feedback.

**Architecture:** Keep the task aggregate in `accepting` after code acceptance and enqueue a `stage_task` runner job. A focused staging coordinator owns PR merge, the shared staging lease, deployment adapter invocation, readback proof, success transition, and failure rollback. The existing development prompt consumes the staging failure comment on the next pass.

**Tech Stack:** Node.js ESM, Miniflare D1, Git/GitHub CLI, ClickUp REST, existing runner lease/fencing infrastructure.

## Global Constraints

- Do not add a ClickUp status.
- Never publish production.
- Never enter `ready_for_test` without confirmed staging runtime evidence.
- Any staging-gate failure returns the task to `ready_for_development` and records a non-sensitive reason.
- Shared staging deployments are serialized.
- Follow repository `AGENTS.md`: implement and prove the direct path before adding broader regression protection.

---

### Task 1: Persist staging attempts and add the rollback transition

**Files:**
- Create: `cloud/migrations/0010_staging_deployments.sql`
- Modify: `orchestration/persistence/migrations.mjs`
- Modify: `orchestration/domain/task-state.mjs`
- Modify: `orchestration/application/task-command-handlers.mjs`

**Interfaces:**
- Produces command `staging_failed(state, { evidenceId })` mapping `accepting → ready_for_development`.
- Produces `staging_deployments` rows keyed by task/candidate/attempt.

- [ ] Add the migration with task, version, PR, task commit, candidate commit, branch, release/readback evidence, stage, status, error and timestamps.
- [ ] Register the migration.
- [ ] Add the explicit `staging_failed` task command and event without changing outward statuses.
- [ ] Run the state transition demonstration and migration smoke check.
- [ ] Commit the focused change.

### Task 2: Stop acceptance from advancing before deployment

**Files:**
- Modify: `orchestration/ai/acceptance.mjs`
- Modify: `cloud/src/clickup-poller.mjs`
- Modify: `scripts/orchestrator.mjs`

**Interfaces:**
- Acceptance accepted result remains completed but does not dispatch `acceptance_passed`.
- Produces one idempotent `stage_task` job containing task id, task commit, PR evidence, target version and version branch.

- [ ] Change accepted code acceptance to return verified evidence while retaining aggregate state `accepting`.
- [ ] Teach the poller to enqueue `stage_task` for accepted `accepting` tasks and avoid duplicate active/completed jobs.
- [ ] Route `stage_task` through the local runner.
- [ ] Demonstrate that accepted code alone leaves ClickUp/internal state in development/accepting.
- [ ] Commit the focused change.

### Task 3: Implement merge, staging serialization, deploy and readback

**Files:**
- Create: `orchestration/application/staging-coordinator.mjs`
- Create: `orchestration/release/staging-adapter.mjs`
- Modify: `orchestration/git/merge.mjs`
- Modify: `scripts/orchestrator.mjs`
- Modify: `.data/orchestration.json` locally only (not committed)

**Interfaces:**
- `executeStagingGate({ job, db, client, gitOps, adapter, now })` returns completed only after readback proof.
- Adapter methods: `deploy({ candidateCommit, versionBranch, taskId, targetVersion })` and `readback({ deployment, candidateCommit })`.

- [ ] Reuse the existing GitHub PR verification/merge primitives and make already-merged retries idempotent.
- [ ] Acquire the fixed `staging-environment` lease before reading the deploy candidate.
- [ ] Implement the configured staging adapter around the existing test-server deployment process without embedding secrets.
- [ ] Reject missing/`local`/mismatched runtime SHA and prove the task commit is an ancestor of the observed candidate.
- [ ] Persist success evidence and dispatch `acceptance_passed` exactly once.
- [ ] Release the staging lease in all outcomes.
- [ ] Demonstrate a successful staging gate against the configured test environment.
- [ ] Commit the focused change.

### Task 4: Return deployment failures to development with usable feedback

**Files:**
- Modify: `orchestration/application/staging-coordinator.mjs`
- Modify: `orchestration/application/failure-handler.mjs`
- Modify: `orchestration/ai/prompts.mjs`
- Modify: `cloud/src/clickup-poller.mjs`

**Interfaces:**
- On any gate failure, dispatches `staging_failed`, posts a sanitized structured comment, and stores evidence.
- The next develop job includes the latest staging failure as a mandatory repair item.

- [ ] Record the failing stage and sanitized reason.
- [ ] Dispatch `staging_failed` to return to `ready_for_development`.
- [ ] Ensure the poller queues the next development generation instead of suppressing it as an ordinary failure.
- [ ] Add the staging feedback to the development prompt and require it to be addressed.
- [ ] Reuse the existing rework budget; move repeated failures to `acceptance_rejected` at the limit.
- [ ] Demonstrate deploy failure → 待开发 → next develop job with failure context.
- [ ] Commit the focused change.

### Task 5: Correct `86d3xmaw8` and prove the real operation path

**Files:**
- Modify: local orchestration D1 records through supported command APIs.
- Modify: ClickUp task `86d3xmaw8` through the existing outbox/client path.

**Interfaces:**
- Reuses PR #881 and task commit `f18e0c2e`; creates no duplicate branch or PR.

- [ ] Restart the orchestrator with the staging adapter configured.
- [ ] Move the incorrect task state back into the staging-gate path without deleting audit history.
- [ ] Run PR merge → staging deployment → `/version` readback.
- [ ] Confirm observed Git SHA contains `f18e0c2e`.
- [ ] Confirm ClickUp changes to「待测试」only after the evidence is stored and comment contains release id, SHA, URLs and time.
- [ ] Update project communication and deployment records; run structure validation.

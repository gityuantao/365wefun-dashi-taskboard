# Published Version Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard faithfully display already-published ClickUp versions without repeated pre-release errors.

**Architecture:** Reconcile the local version aggregate in the poller using domain commands only, then make terminal version details bypass pre-release eligibility. Deduplicate ordinary eligibility gaps at their source.

**Tech Stack:** Node.js ESM, Cloudflare D1 test harness, `node:test`.

## Global Constraints

- Do not read, modify, delete, stage, or commit `.data`.
- Do not invoke production release adapters or write ClickUp status during reconciliation.
- Preserve readiness behavior for non-terminal versions.

---

### Task 1: Reconcile published snapshots

**Files:**
- Modify: `cloud/src/clickup-poller.mjs`
- Modify: `orchestration/application/version-command-handlers.mjs`
- Test: `test/orchestration/clickup-poller.test.mjs`

- [ ] Add a failing test proving an unchanged published snapshot advances an active aggregate to published without ClickUp mutations.
- [ ] Add the minimal legal internal transition sequence and run the focused poller test.

### Task 2: Make published details historical and deduplicate gaps

**Files:**
- Modify: `orchestration/dashboard/queries.mjs`
- Modify: `orchestration/release/release-eligibility.mjs`
- Test: `test/orchestration/dashboard.test.mjs`
- Test: `test/orchestration/release-eligibility.test.mjs`

- [ ] Add failing tests for a gap-free published detail and one gap per missing platform.
- [ ] Implement terminal detail handling and stable gap deduplication.
- [ ] Run focused tests, orchestration regression tests, and live API verification after restart.

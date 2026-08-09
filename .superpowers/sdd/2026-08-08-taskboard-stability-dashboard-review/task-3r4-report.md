# Task 3R4 report — drain jobs and recover only safe leases

## Status

Completed. The live paused orchestrator was not started, restarted, enabled, or contacted, and no real GitHub or ClickUp writes were performed.

## Root cause

- `scripts/orchestrator.mjs` discarded every `claimed` lease at startup, including live unexpired claims.
- The runtime did not retain the polling interval or active job/Codex handles, so SIGINT/SIGTERM could not stop claims, cancel Codex, drain settlement, or close Dashboard/Miniflare deterministically.
- Fencing was checked only by `completeJob`; Git/GitHub/ClickUp durable boundaries could already have run under a stale lease.

## TDD evidence

Focused RED was observed before production implementation:

- `orchestrator-lifecycle.test.mjs` failed because `createOrchestratorLifecycle` / `guardDurableMethods` did not exist.
- the new runner-job tests failed because safe recovery and `assertJobClaim` did not exist.
- the Codex cancellation case could not settle because `runCodex` ignored `AbortSignal`.

The production path now uses the same injected lifecycle and side-effect guards exercised by the tests.

## Changes

- Added signal-aware orchestration lifecycle tracking: stop claims, clear polling, reconcile a claim that races shutdown, abort active Codex children, await job settlement, then close Dashboard and Miniflare.
- Added safe lease recovery: startup requeues only expired claims; live claims require explicit reconciliation.
- Added active lease/fencing assertions, including lease expiry, and made completion conditional on the same live claim.
- Guarded every ClickUp mutation method and each Git/GitHub write step in the job runtime immediately before the durable boundary.
- Preserved the existing `waiting_info` cooperative guards and `paused_waiting_info` classifications unchanged.

## Verification

```text
node --test \
  test/orchestration/orchestrator-lifecycle.test.mjs \
  test/orchestration/codex-runner.test.mjs \
  test/orchestration/runner-jobs.test.mjs

18 passed, 0 failed
```

Manual waiting-info regression suite:

```text
node --test \
  test/orchestration/analyzer.test.mjs \
  test/orchestration/developer.test.mjs \
  test/orchestration/acceptance.test.mjs \
  test/orchestration/clickup-poller.test.mjs

75 passed, 0 failed
```

Syntax and patch checks:

- `node --check` passed for all three modified production modules.
- `git diff --check` passed.

## Concerns

- Fencing is validated immediately before each exposed durable boundary. Atomicity across a remote API request itself remains governed by that remote system; the local lease cannot be atomically committed with GitHub or ClickUp.

## Fix round 1

Two review findings were addressed with focused RED → GREEN coverage:

- Codex abort now sends SIGTERM and remains unsettled until the child emits `close`. After the configurable short grace period it escalates to SIGKILL, then either observes `close` or rejects with `TERMINATION_TIMEOUT`. Lifecycle tests prove Dashboard and Miniflare close only after that settlement.
- Fencing guards are injected inside compound helpers. `createTaskWorktree` checks after its branch/worktree reads and immediately before `git worktree add`; `createPullRequest` checks after `gh pr view` and immediately before `gh pr create`. Tests invalidate the lease during the read and prove the mutation count stays zero.
- The runtime supplies `codexAbortGraceMs` / `codexAbortForceCloseMs` configuration and passes the job claim guard into both helpers.

Fix-round focused verification:

```text
node --test \
  test/orchestration/codex-runner.test.mjs \
  test/orchestration/orchestrator-lifecycle.test.mjs \
  test/orchestration/worktree-runner.test.mjs \
  test/orchestration/pr.test.mjs

25 passed, 0 failed
```

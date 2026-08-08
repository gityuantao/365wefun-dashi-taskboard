# Taskboard orchestration evidence review

Date: 2026-08-08

Scope: ClickUp admission through analysis, development, acceptance, version integration/release, D1 recovery, Dashboard controls, and local server boundaries.

Method: read-only code review plus focused tests and small read-only reproductions. No production ClickUp, GitHub, or deployment write was performed.

## Baseline and commands

- Working tree: `codex/taskboard-stability-dashboard` at pre-review commit `4e1a9ba`.
- Node: `v24.14.0`.
- pnpm: `11.16.0` (matches `packageManager: pnpm@11.16.0`).
- The previously supplied `77/77` result is the narrower Task 2 subset. The Task 3 mandated `pnpm test:orchestration` command currently discovers 210 tests.

### Focused orchestration suite

Command:

```bash
/usr/bin/time -p pnpm test:orchestration
```

Exact summary:

```text
ℹ tests 210
ℹ suites 0
ℹ pass 209
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14450.871541
[ELIFECYCLE] Command failed with exit code 1.
real 14.70
user 48.50
sys 8.58
```

Every failing test (one):

```text
test at test/orchestration/mvp-e2e.test.mjs:315:1
✖ failed development blocks without advancing the task (674.715958ms)
AssertionError [ERR_ASSERTION]: failed development must not advance the task
4 !== 0
at test/orchestration/mvp-e2e.test.mjs:336:10
```

Deterministic single-test reproduction:

```bash
/usr/bin/time -p node --test \
  --test-name-pattern='failed development blocks without advancing the task' \
  test/orchestration/mvp-e2e.test.mjs
```

Result: 0 passed, 1 failed, `duration_ms 812.40675`, `real 0.83`; the same `4 !== 0` assertion failed at line 336.

### Branch and PR routing suite

Command:

```bash
/usr/bin/time -p node --test \
  test/orchestration/worktree-runner.test.mjs \
  test/orchestration/pr.test.mjs \
  test/orchestration/git-merge.test.mjs
```

Result: 14 passed, 0 failed, `duration_ms 600.890167`, `real 0.62`.

Command:

```bash
rg -n "baseRef|versionBranch|staging|createWorktree|createPullRequest" \
  cloud/src orchestration scripts test/orchestration
```

Result:

- `cloud/src/clickup-poller.mjs:168-171` sets `baseRef` to `CLICKUP_BASE_REF ?? "main"` and PR target to `version/<normalized target version>`.
- `orchestration/runner/worktree.mjs:22-41` creates a new `task/<id>` branch from that `baseRef`.
- `orchestration/ai/developer.mjs:117-122,184-189` uses the worktree baseline and creates the PR against `versionBranch ?? baseRef`.
- `scripts/orchestrator.mjs:120,139-158` defaults the baseline to `main`, creates a missing version branch from `baseRef`, pushes the task branch, and opens the PR.
- No orchestration code path uses `staging` as a task development baseline.
- This proves the creation/routing path, but not version integration: `mergeTaskPrToVersionBranch` has no production caller (finding ORCH-P0-001).

### Idempotency and recovery suite

Command:

```bash
/usr/bin/time -p node --test \
  test/orchestration/clickup-poller.test.mjs \
  test/orchestration/d1-event-store.test.mjs \
  test/orchestration/dispatch-command.test.mjs \
  test/orchestration/failure-handler.test.mjs \
  test/orchestration/mvp-e2e.test.mjs
```

Exact summary:

```text
ℹ tests 41
ℹ suites 0
ℹ pass 40
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 12692.11375
real 12.71
user 14.69
sys 2.22
```

Every failing test (one): the same `failed development blocks without advancing the task` assertion at `test/orchestration/mvp-e2e.test.mjs:336`, actual aggregate version 4 versus expected 0.

Additional targeted verification:

- Release/Dashboard controls: 11 passed, 0 failed (`release-commands`, `web-adapter`, `dashboard-http`, and `control-http`; `duration_ms 2368.596625`). The dashboard malformed-URL test intentionally logs `TypeError: Invalid URL` and still passes.
- Version/development ordering: 17 passed, 0 failed (`development-order`, `version-assignment`, and `version-gate`; `duration_ms 1003.204625`). These tests do not model relationship arrays in development-order.
- Outbox: 5 passed, 0 failed (`duration_ms 989.521208`). The suite proves delivery and local confirmation, but does not verify `expected_before` or remote readback.

## A. Inbox and external-task admission

Entry → decision → side effect → observable result → recovery:

1. `pollClickUpOnce` reads versions first, chooses the lowest unreleased version, then normalizes each task (`cloud/src/clickup-poller.mjs:186-219`). A non-current target version is snapshotted and skipped.
2. A new inbox task dispatches `start_analysis` (`cloud/src/clickup-poller.mjs:329-347`), producing an event/aggregate update and a ClickUp status mutation via `runCommand` (`:493-527`). The analysis job is then enqueued by aggregate state (`:86-183`).
3. A previously unmanaged task already in `待开发` or `开发中` is admitted through two synthetic commands (`inbox → analyzing → ready_for_development`) at `cloud/src/clickup-poller.mjs:285-320`, then receives a development job.
4. Repeated unchanged polls use deterministic command/job IDs and existing command/job checks (`:94-140`, `:221-226`). Tests cover unchanged-snapshot idempotency and both external-import statuses.

Recovery is present for deterministic D1 command/job creation. The external import intentionally trusts the user's already-ready status and therefore does not produce analysis criteria; this should remain explicit product behavior if retained.

## B. Analysis and waiting-for-information recovery

1. The analysis job reads the ClickUp task/comments, invokes Codex, validates structured JSON, and writes the comment, description, summary, and acceptance fields (`orchestration/ai/analyzer.mjs:68-165`).
2. Open questions or a missing target version dispatch `analysis_needs_human`, leaving the aggregate in `waiting_info`, then post recovery instructions (`:47-66,109-145`).
3. When the user returns the ClickUp status to `分析中`, the poller deletes the matching `needs_human` failed job and dispatches `analysis_restarted` (`cloud/src/clickup-poller.mjs:32-55,250-266`).
4. Observable state is the aggregate/event, ClickUp comment/status outbox, and runner job. Repeated job failure is delayed by the five-minute retry window unless it is a parked human-input result (`:111-139`).

No new P0/P1 was verified in this path. The analyzer merely checks relationship-field truthiness at `orchestration/ai/analyzer.mjs:129-146`; normalized version routing occurs before execution.

## C. Development worktree, commit, and PR creation

1. A development job is admitted only for the current version and after `checkDevelopmentOrder` (`scripts/orchestrator.mjs:220-250`).
2. A new worktree branch is `task/<taskId>` from `main`/configured frozen baseline (`orchestration/runner/worktree.mjs:22-50`). There is no `staging` baseline path.
3. Codex runs inside the task worktree, changes are committed, and the task PR targets `version/<target>` (`orchestration/ai/developer.mjs:117-193`). A missing version branch is created from the same `baseRef` before the task branch is pushed (`scripts/orchestrator.mjs:139-158`).
4. The PR URL is written to ClickUp, then `development_completed` advances the aggregate to acceptance (`orchestration/ai/developer.mjs:196-216`).
5. A Codex/parse failure dispatches `development_failed` and returns to `ready_for_development` (`:29-59,161-181`). A stale job on a parked task refuses to restart (`:123-155`).

The relationship-array reproduction for ORCH-P1-002 returned:

```json
{"result":{"blocked":false},"aggregateReads":0}
```

The same fixture with legacy string version values returned a block for the unfinished predecessor. Thus branch routing is correct only after an ordering gate that currently fails for the authoritative ClickUp relationship representation.

## D. Testing and acceptance rejection/retry

1. Development completion enters `accepting`; the poller enqueues acceptance with the latest analysis criteria (`cloud/src/clickup-poller.mjs:142-179`).
2. Acceptance invokes Codex in the task worktree. An accepted result requires a target version and advances to `ready_for_test` (`orchestration/ai/acceptance.mjs:49-120`).
3. A rejection records a rework round, posts findings, and either returns to `ready_for_development` or parks at `acceptance_rejected` after three rounds (`:122-166`; `orchestration/application/failure-handler.mjs:1-41`). The user can then explicitly route it back to development or testing (`cloud/src/clickup-poller.mjs:372-405`).
4. Manual ClickUp moves from ready/testing to `待发布` or `待开发` become test pass/fail commands with evidence (`:408-485`). State-machine tests cover direct and explicit testing routes.

The test/retry behavior is observable in aggregate events, rework blockers, comments/feedback fields, and Dashboard activity. The deterministic failing MVP test is documented as ORCH-P2-006; it is an obsolete version-count assertion after external admission plus start/rollback, not evidence that a failed run reaches acceptance/release.

## E. Version assignment, integration, Candidate, and release

1. Missing versions are assigned through the ClickUp `list_relationship` write `{ add: [versionTaskId], rem: [] }` (`orchestration/application/version-assignment.mjs:25-77`). Existing relationship arrays are normalized by `targetVersionName` (`orchestration/application/version-gate.mjs:48-67`).
2. Task PRs target the version branch, but production code never calls `mergeTaskPrToVersionBranch`; only its isolated unit test imports it.
3. `freezeManifest` stores only `versionId`, task IDs, timestamp, and a checksum over those values (`orchestration/release/version-aggregator.mjs:53-78`). It contains no version-branch/RC commit, artifact identity, regression result, or immutable Candidate reference.
4. When ClickUp version status becomes `releasing`, `releaseCoordinator` uses an in-memory deployer whose preflight and health checks always succeed and whose upload/switch methods only return fabricated metadata (`scripts/orchestrator.mjs:321-363`).
5. `handleConfirmRelease` therefore writes `version.published` and publishes every manifest task (`orchestration/application/release-commands.mjs:49-93`). The coordinator then forcibly removes task worktrees/local branches, closes PRs, and deletes remote task branches (`scripts/orchestrator.mjs:364-385`).
6. There is no Candidate creation, version-level build/regression, staging-by-SHA, main promotion, or remote-state verification path. ORCH-P0-001 is the resulting hard stop.

## F. Polling idempotency, leases, restart, and stale jobs

1. Commands are idempotent by command ID and atomically batch command/event/projection writes (`orchestration/application/dispatch-command.mjs:15-91`; `orchestration/persistence/d1-event-store.mjs:44-158`). Version conflicts and hash-chain continuity are tested.
2. Jobs claim with an atomic status predicate and fencing token; completion validates claimant/token (`orchestration/persistence/d1-runner-jobs.mjs:32-102`). Tests cover live claims, expired takeover, and stale completion rejection.
3. The local orchestrator claims each type with a 90-minute lease and starts jobs without awaiting them (`scripts/orchestrator.mjs:539-555`). On startup it unconditionally resets every claimed row to queued (`:279-285`).
4. There is no orchestrator SIGINT/SIGTERM shutdown handler, interval cancellation, Dashboard/Miniflare close, active-job drain, or Codex cancellation (`:595-598`; compare the explicit close path in `server/index.mjs:23-30`). Fencing prevents a stale runner from recording completion but cannot undo Git, GitHub, ClickUp, or Codex side effects already executed. This is ORCH-P1-004.
5. `runCompanionOnce` treats any normally returned result as completed, including `{status:"failed"}`, because only thrown errors post `failed` (`orchestration/runner/companion.mjs:43-50`). The production local orchestrator uses its own correct `result.status` mapping, so this is recorded as P2 rather than a local-runtime P1.

## G. Dashboard read model and control mutations

1. Read models join ClickUp snapshots with aggregate state, runner results, blockers, manifests, and events (`orchestration/dashboard/queries.mjs:38-365`). Task list status favors the user-visible ClickUp snapshot while version status favors the aggregate.
2. The Dashboard binds to `127.0.0.1`, exposes read/control routes, and writes control state atomically through a temporary file/rename (`orchestration/dashboard/http-server.mjs:36-189`; `orchestration/control.mjs:14-41`).
3. Publishing verifies the local read model is releasable, then enqueues a ClickUp version-status mutation (`orchestration/dashboard/http-server.mjs:96-147`). The mutation is the observable trigger consumed by the release coordinator.
4. The standalone server has no authentication or Host/Origin validation. The existing test invokes a bare POST and receives 200 (`test/orchestration/dashboard-http.test.mjs:85-123`). A client able to reach loopback can send a cross-origin POST even when it cannot read the response. That can trigger the release path and is ORCH-P1-005.

## H. Server shutdown, secrets, and local-network boundary

1. The main Taskboard server rejects public Host/Origin values, restricts local capability/orchestration proxy routes to loopback, and keeps cloud shared secrets in the local config store (`server/app.mjs:130-187,1346-1367,1584-1677`). The corresponding LAN tests pass in the broader server suite baseline documented by prior tasks.
2. The server can bind to `127.0.0.1` or `0.0.0.0`; the CLI default is `0.0.0.0` for the intentionally supported private-LAN mode (`server/app.mjs:1309-1315`; `server/index.mjs:8-20`). General local-mode project/task APIs are intentionally LAN-accessible without authentication. This matches the confirmed personal/LAN scope but remains an operational trust assumption: do not expose port 47823 through router/public forwarding.
3. Main-server SIGINT/SIGTERM closes SSE clients, AI runs, HTTP, and the database (`server/app.mjs:2163-2175`; `server/index.mjs:23-30`). The separate orchestrator lacks equivalent shutdown handling (ORCH-P1-004).
4. The orchestrator obtains the ClickUp token from an environment variable or `runtime.tokenPath` (`scripts/orchestrator.mjs:70-75`) and does not log it. Its local Miniflare shared secret is a hard-coded development value at `:79-93`; the Dashboard is direct loopback and does not use that binding.

## Findings

| ID | priority | path | evidence | impact | verification | remediation |
|---|---|---|---|---|---|---|
| ORCH-P0-001 | P0 | `scripts/orchestrator.mjs:321-385`; `orchestration/application/release-commands.mjs:49-93`; `orchestration/release/version-aggregator.mjs:53-78`; `orchestration/git/merge.mjs:7-27` | The live coordinator injects always-success placeholder deploy methods, the manifest has no commit/Candidate, and the only merge helper has no production caller. A returned success marks version/tasks published and then closes/deletes task PR branches. | ClickUp and Git remotes can report a production release that never integrated or deployed task code; cleanup can remove the remaining remote task branch/PR evidence. This is an irreversible/remote false-release path. | `rg -n "mergeTaskPrToVersionBranch|preflight: async|upload: async|switchEntry: async|healthCheck: async|removeTaskWorktree|closeTaskPullRequest|deleteRemoteTaskBranch|release_succeeded|publish_task" orchestration scripts test/orchestration` shows the merge helper only in its unit test and the placeholder/cleanup chain in the runtime. The release unit suites pass only with mock deployers (11/11 targeted tests). | Disable release triggering/cleanup until a reviewed integration flow merges verified task PR heads into `version/<target>`, freezes an immutable Candidate commit/artifact plus version-level regression evidence, promotes that exact Candidate, verifies remote deployment, and only then publishes/cleans branches. |
| ORCH-P1-002 | P1 | `orchestration/application/development-order.mjs:12-16,38-50` | `targetVersionOf` returns raw ClickUp field values and compares them with `===`. The authoritative value is a fresh relationship array for each task, so equal versions do not compare equal. | Higher-priority unfinished siblings are omitted; same-version development can run out of order, invalidating the claimed baseline/dependency sequencing. | A read-only Node reproduction with two distinct `[{id:"version-1",name:"1.0.1"}]` arrays returned `{"blocked":false,"aggregateReads":0}`. The same fixture using legacy strings returned `blocked:true`. The 17 passing version/order tests cover strings but not relationship arrays. | Normalize with the same `targetVersionName`/configured field helper used by assignment/gating, and add a relationship-array regression proving an unfinished predecessor blocks. |
| ORCH-P1-003 | P1 | `orchestration/clickup/outbox.mjs:54-79`; `cloud/src/clickup-poller.mjs:516-526`; `cloud/migrations/0004_outbox_mutations.sql:1` | Mutations persist `expected_before`, but `flushOutbox` never reads or compares it and marks confirmed immediately after the update call, without ClickUp readback. | A queued stale mutation can overwrite a newer manual ClickUp status (for example, restore `待开发` after the user canceled/moved the task), causing state drift and unintended re-entry. Unknown outcomes can also be blindly retried. | A mock flush with `expected_before="开发中"` and a simulated current remote status `已取消` made no `getTask` call, still called `updateTaskStatus(task-1, "待开发")`, and returned the mutation as flushed/confirmed. Existing outbox tests pass 5/5 but do not assert precondition/readback. | Before execution, read/normalize the authoritative remote value and compare it with `expected_before`; classify conflict/unknown separately. After write, read back the target before confirmation. Retry only operations with proven safe/idempotent semantics. |
| ORCH-P1-004 | P1 | `scripts/orchestrator.mjs:279-285,539-598`; `orchestration/runner/codex-runner.mjs:20-51`; `orchestration/persistence/d1-runner-jobs.mjs:32-102` | Jobs run detached from the tick (`void runJob`); startup resets all claimed jobs, including unexpired ones; there is no shutdown/drain/child cancellation. Fencing is checked only when recording the job result. | After stop/crash/restart, an orphan Codex/Git/ClickUp execution may continue while the reset job runs again, causing duplicate development or remote side effects. | Static lifecycle search finds SIG handlers only in `server/index.mjs`, while the orchestrator ends with `recoverOrphanedLeases`, `tick`, and `setInterval`. Lease tests prove stale completion rejection but do not fence side effects. | Add orchestrator shutdown state, stop scheduling, cancel/await active runners, close Dashboard/Miniflare, and recover only expired leases. Thread a fencing/abort check through every pre-side-effect boundary and reconcile remote facts before retry. |
| ORCH-P1-005 | P1 | `orchestration/dashboard/http-server.mjs:36-47,96-147,181-189`; `test/orchestration/dashboard-http.test.mjs:85-123` | The loopback Dashboard accepts publish POSTs without authentication or Host/Origin validation. The existing test proves a bare POST immediately enqueues the releasing mutation. | An untrusted local client, DNS-rebinding origin, or browser/runtime that permits a cross-origin loopback POST can trigger a version release without user authorization. | Code review finds no request-origin/secret check before `enqueueMutation`; the Dashboard test confirms status 200 and a persisted `发布中` mutation without credentials. | Require an unguessable session/CSRF token and validate Host/Origin/Sec-Fetch-Site for control mutations, or remove direct mutations from the standalone listener and accept them only through the main server's loopback-validated proxy. |
| ORCH-P2-006 | P2 | `test/orchestration/mvp-e2e.test.mjs:315-336`; `cloud/src/clickup-poller.mjs:285-320`; `orchestration/ai/developer.mjs:123-163` | The deterministic test still expects aggregate version 0 after the poller imports an external `待开发` task (versions 1-2), development starts (3), and failure rollback is recorded (4). | The mandated orchestration suite is red and cannot serve as a release/dashboard regression baseline, although the final state correctly returns to `ready_for_development`. | Full suite 209/210; recovery subset 40/41; isolated reproduction 0/1, always actual 4 versus expected 0. `git show 5bea561 -- cloud/src/clickup-poller.mjs test/orchestration/mvp-e2e.test.mjs` shows external-import behavior was added without updating this assertion. | Amend the test to assert the intended final state and exact event/version sequence for imported-task failure. Do not erase the rollback event merely to preserve version 0. |
| ORCH-P2-007 | P2 | `orchestration/runner/companion.mjs:23-50`; `scripts/companion.mjs:12-19` | `runCompanionOnce` posts `completed` for a handler that returns `{status:"failed"}`; only a thrown error posts failed. The shipped companion script supplies no handlers, so a claimed job throws instead of executing orchestration work. | The generic/cloud companion contract can misclassify domain failures and the shipped script cannot process a real job. The integrated local orchestrator is not affected because it maps `result.status` itself. | Source trace plus passing companion tests show only successful returns and thrown errors are distinguished; there is no returned-failure test. | Map handler result status explicitly, require a callable handler before claim or ship real handlers, and add returned-failure coverage. |

## P0/P1 remediation gate

Gate result: STOP — implementation plan amendment required before Dashboard work.

Tasks 4–8 must not proceed unchanged. The plan needs explicit remediation tasks and targeted regression evidence for:

1. `ORCH-P0-001`: disable the false-release/cleanup path, then implement verified integration/Candidate/promotion semantics.
2. `ORCH-P1-002`: normalize `list_relationship` in development ordering.
3. `ORCH-P1-003`: enforce outbox preconditions and remote confirmation/reconciliation.
4. `ORCH-P1-004`: add orchestrator shutdown/drain and safe lease recovery.
5. `ORCH-P1-005`: protect local Dashboard mutations from cross-site/unauthorized requests.
6. `ORCH-P2-006`: restore a green, semantics-accurate `pnpm test:orchestration` baseline before subsequent feature work.

No remediation was implemented during this audit.

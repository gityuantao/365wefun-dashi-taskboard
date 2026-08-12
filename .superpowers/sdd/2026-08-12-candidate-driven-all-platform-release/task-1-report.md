# Task 1 report — Candidate scope and release eligibility

Status: DONE

## Legacy audit

The interrupted implementation left two untracked files: `orchestration/release/candidate-scope.mjs` and `test/orchestration/candidate-scope.test.mjs`. The implementation had the intended command allowlist and path table, but its tests did not establish the required RED state: their first run failed on an expected-platform sort mismatch and a `master` branch assumption, not because the module was absent. I corrected the test portability issues, deleted the production file, and re-ran RED before restoring a minimal implementation. `.data` was observed as pre-existing untracked state and was neither read, modified, staged, nor committed.

## RED evidence

- `node --test test/orchestration/candidate-scope.test.mjs`
  - Expected/observed failure: `ERR_MODULE_NOT_FOUND` for `orchestration/release/candidate-scope.mjs`.
- `node --test test/orchestration/release-eligibility.test.mjs test/orchestration/dashboard.test.mjs test/orchestration/version-aggregator.test.mjs`
  - Observed failure: `ERR_MODULE_NOT_FOUND` for `orchestration/release/release-eligibility.mjs`. The legacy card/detail tests were otherwise green, so there was no truthful pre-existing evidence of the brief's stated card/detail disagreement; new eligibility cases established the missing contract directly.
- `node --test test/orchestration/release-eligibility.test.mjs`
  - Observed failing assertions before the minimal change: a 38th task without evidence and `86d40ejq2` incorrectly became ready from Candidate scope. The implementation was tightened so Candidate scope supplements only an existing, explicitly missing evidence record.

## GREEN verification

Command:

```sh
node --test test/orchestration/candidate-scope.test.mjs test/orchestration/release-eligibility.test.mjs test/orchestration/release-scope.test.mjs test/orchestration/version-aggregator.test.mjs test/orchestration/dashboard.test.mjs test/orchestration/git-merge.test.mjs test/orchestration/release-coordinator.test.mjs test/orchestration/production-platform-gate.test.mjs test/orchestration/release-commands.test.mjs
```

Summary: 75 tests passed, 0 failed, exit code 0. This test suite uses temporary Git remotes and the local Cloudflare Worker harness only; it did not SSH, query production DBs, upload binaries, submit stores, publish releases, or write ClickUp.

## Changed files

- `orchestration/release/candidate-scope.mjs`
- `orchestration/release/release-eligibility.mjs`
- `orchestration/release/release-scope.mjs`
- `orchestration/release/platform-gate.mjs`
- `orchestration/release/version-aggregator.mjs`
- `orchestration/application/release-coordinator.mjs`
- `orchestration/application/release-commands.mjs`
- `orchestration/git/merge.mjs`
- `orchestration/dashboard/queries.mjs`
- `test/orchestration/candidate-scope.test.mjs`
- `test/orchestration/release-eligibility.test.mjs`
- `test/orchestration/release-scope.test.mjs`
- `test/orchestration/version-aggregator.test.mjs`
- `test/orchestration/dashboard.test.mjs`

## Self-review

- Candidate classifier validates exact 40-character commits, verifies their existence and ancestry, executes only `rev-parse`, `merge-base --is-ancestor`, and `diff --name-only -z` through the injected/local Git runner, and does not inspect the checkout diff.
- Candidate targets are exact path mappings with a mapping version; native Android is closed as unsupported, and Android TWA projects to web.
- Eligibility is the canonical object returned by the version gate and Dashboard card/detail. It retains evidence source, identifier, commit and accepted-commit provenance, detects Candidate/client drift, and closes on missing evidence, blockers, unsupported targets, or runtime gaps.
- Candidate-base commit is carried from Git integration to freeze, where exact Candidate changes are classified and persisted in the frozen manifest.
- `git diff --check` passed before the final verification run.

## Commit

Implementation commit: `f511869d39e96de6967f7a93b6086128769a41d5` (`feat: derive release eligibility from candidate`).

## Concerns

- Existing historical manifests without `candidateScope` remain supported and use their frozen task platform plan. New Candidate freezes persist Candidate scope and the canonical eligibility snapshot.
- The report itself is the only task artifact outside the source/test paths; `.data` remains excluded.

---

## Fix round 1/5 — reviewer findings

Status: DONE

### RED evidence

- `node --test test/orchestration/candidate-scope.test.mjs test/orchestration/production-platform-gate.test.mjs`
  - Observed: mini-program Candidate scope was classified as unsupported by the production platform gate.
- `node --test test/orchestration/release-scope.test.mjs test/orchestration/git-merge.test.mjs`
  - Observed: accepted-PR scope supplementation and fail-closed accepted-commit behavior were absent; the merged-PR baseline was equal to the Candidate commit.
- `node --test test/orchestration/dashboard.test.mjs test/orchestration/dashboard-http.test.mjs`
  - Added failing coverage for canonical API eligibility shape and the empty iOS App registry branch; prior code referenced a deleted `gaps` variable.
- `node --test test/orchestration/release-coordinator.test.mjs`
  - Added a Candidate mini-program integration test that required platform-plan construction after Candidate classification.

### GREEN verification

```sh
node --test test/orchestration/candidate-scope.test.mjs test/orchestration/release-eligibility.test.mjs test/orchestration/release-scope.test.mjs test/orchestration/version-aggregator.test.mjs test/orchestration/dashboard.test.mjs test/orchestration/dashboard-http.test.mjs test/orchestration/git-merge.test.mjs test/orchestration/release-coordinator.test.mjs test/orchestration/release-commands.test.mjs test/orchestration/production-platform-gate.test.mjs
```

Summary: 91 passed, 0 failed, exit code 0. The only visible `Invalid URL` stack is an existing negative HTTP-request test that still passes. Test activity is restricted to temporary Git remotes and local worker harnesses; no production SSH, database, store upload, release, or ClickUp write occurred.

### Changes and self-review

- Moved the non-frozen release gate and target-plan build into the Candidate freeze boundary, so Candidate classification can supplement a missing task scope before the production plan is derived.
- Added `mini_program` to the configured platform path, target plan, production target execution, release adapter validation, Dashboard projection, and tests; native Android remains closed and TWA still projects to Web.
- Preserved the complete canonical eligibility object in frozen manifests and reused a clone unchanged for details; the HTTP response now exposes production runtime readiness separately rather than rewriting eligibility.
- Fixed merged-PR Candidate bases using the merge commit's first parent; covered a merged-PR Candidate baseline that differs from Candidate head.
- Added accepted PR change-scope evidence support, retained provenance fields in canonical task-platform evidence, and covered fail-closed mismatched accepted commits.
- Repaired the iOS empty-App gap to append to the canonical eligibility object and recompute readiness.

### Commit

Pending commit SHA at report append time; supplied in the follow-up commit.

### Concerns

- Accepted PR change-scope data is accepted through `resolveReleasePlatformEvidence` as explicit audited input. The current runner-job schema does not yet persist exact changed paths, so a later schema/runner task should populate that input from accepted PR diffs rather than only platform summaries.
- `.data` remains untracked and untouched.

---

## Fix round 2/5 — remaining release-boundary findings

Status: DONE

### RED evidence

- `node --test test/orchestration/production-runtime-wiring.test.mjs`
  - Observed before implementation: `configuredReleaseTargets` was not exported; the runtime had no structured target readiness boundary.
- `node --test test/orchestration/release-scope.test.mjs test/orchestration/candidate-scope.test.mjs`
  - Observed while adding persisted accepted-PR evidence: a Worker import rejected `node:child_process` from the Candidate classifier. The path classifier was separated into a pure module; tests then established accepted-commit mismatch failure and exact changed-path classification.
- `node --test test/orchestration/production-release-persistence.test.mjs`
  - Observed: `CHECK constraint failed: platform IN ('web', 'api', 'ios')` for a terminal mini-program success row. A forward-only `0014` migration makes the existing persisted-target table accept the immutable mini-program target.
- `node --test test/orchestration/dashboard.test.mjs test/orchestration/dashboard-http.test.mjs`
  - Observed after tightening the default runtime input: four legacy direct-query cases failed because they relied on an implicit hard-coded ready platform set. Tests now inject explicit structured runtime readiness; the query default is fail-closed.

### GREEN verification

```sh
git diff --check && node --test test/orchestration/candidate-scope.test.mjs test/orchestration/release-eligibility.test.mjs test/orchestration/release-scope.test.mjs test/orchestration/version-aggregator.test.mjs test/orchestration/dashboard.test.mjs test/orchestration/dashboard-http.test.mjs test/orchestration/git-merge.test.mjs test/orchestration/release-coordinator.test.mjs test/orchestration/release-commands.test.mjs test/orchestration/production-platform-gate.test.mjs test/orchestration/production-runtime-wiring.test.mjs test/orchestration/production-release-persistence.test.mjs test/orchestration/production-release-coordinator.test.mjs
```

Summary: `git diff --check` passed; 146 tests passed, 0 failed, exit code 0 (14.9 s). The only visible `Invalid URL` stack is the existing negative HTTP parsing test, which passes. Tests use temporary Git remotes and the local Worker harness only; no production SSH/DB, real ClickUp mutation, WeChat action, Apple upload/submission, or release publication occurred.

### Changes and self-review

- Added explicit, structured runtime `releaseTargets`; all gate, dashboard and coordinator production paths derive configured targets from this boundary, and missing descriptors fail closed. The example leaves `mini_program` disabled until an operator intentionally configures its adapter boundary.
- Made Candidate-base resolution order-independent by resolving a common Git ancestry from all merged/open integration anchors; covered ordering plus mixed integration paths.
- Preserved the full canonical `releaseEligibility` object (including Candidate scope, evidence IDs/commits, aggregate version and Android-delivery provenance) through freeze, cards, details and HTTP. Runtime, workflow and iOS gaps are supplied to the canonical builder before construction, never appended afterward.
- Added a persisted accepted-PR changed-path pipeline: developer result, accept result, Worker poller, runner-job readback, pure path classification and exact accepted-commit matching. ClickUp/analyze/develop evidence tied to another commit is rejected.
- Added mini-program persistence migration and terminal-success reuse support; no live external mini-program adapter is introduced.
- `scripts/orchestrator.mjs` passes the runtime-derived configured target list through both dashboard and release-coordinator boundaries.
- Scope audit: only Task 1 source, migration, tests, runtime example and this report are included. `.data` was neither read, modified, staged nor committed.

### Commit

Implementation commit: `321160429204b07e0c42d780f2b7a3928009d72f` (`fix: complete candidate release eligibility`).

### Concerns

- A deployment must apply migration `0014_mini_program_production_target.sql` before it can persist mini-program release attempts. This work deliberately did not run any migration against a real environment.
- An operator must explicitly enable the mini-program target in private runtime configuration before it is eligible; the provided example remains held and disabled by default to prevent accidental external operation.

---

## Fix round 3/5 — capability and mixed-PR integration boundaries

Status: DONE

### RED evidence

- `node --test test/orchestration/production-runtime-wiring.test.mjs`
  - A release target merely marked `mini_program` with `release_adapter` was reported configured, and no dedicated adapter boundary existed. New assertions failed: the generic target list contained `mini_program`, and `runtime.miniProgramAdapter` was absent.
- `node --test test/orchestration/production-release-coordinator.test.mjs`
  - A mini-program target was routed to the generic Web/API adapter and returned `waiting_external` rather than completing through the fake dedicated adapter.
- `node --test test/orchestration/git-merge.test.mjs`
  - The new real temporary-repository end-to-end case failed for open-then-merged task order: its exact Candidate diff was missing `apps/web/open.mjs`, because merged-PR refresh overwrote the existing local Candidate integration.

### GREEN verification

```sh
git diff --check && node --test test/orchestration/candidate-scope.test.mjs test/orchestration/release-eligibility.test.mjs test/orchestration/release-scope.test.mjs test/orchestration/version-aggregator.test.mjs test/orchestration/dashboard.test.mjs test/orchestration/dashboard-http.test.mjs test/orchestration/git-merge.test.mjs test/orchestration/release-coordinator.test.mjs test/orchestration/release-commands.test.mjs test/orchestration/production-platform-gate.test.mjs test/orchestration/production-runtime-wiring.test.mjs test/orchestration/production-release-persistence.test.mjs test/orchestration/production-release-coordinator.test.mjs
```

Summary: `git diff --check` passed; 151 tests passed, 0 failed, exit code 0 (14.9 s). Tests used only temporary Git repositories and the local Worker harness. No production SSH/DB, ClickUp mutation, WeChat operation, Apple upload/submission, or release publication occurred.

### Changes and self-review

- `mini_program` may be configured only with an explicit `mini_program_adapter` descriptor and module path. A generic Web/API adapter is rejected before readiness; an unavailable dedicated factory reports no configured targets. The generic adapter never receives mini-program release/readback calls.
- Added the typed dedicated adapter route through runtime, coordinator, confirmation command and persistent target executor. The test implementation is a fake only; Task 3's real WeChat protocol is deliberately not implemented.
- Preserved a local version-branch Candidate when it already descends from the freshly fetched remote base. Merged PR validation still reads remote history, but no longer replaces earlier open-PR integration. Real temporary Git tests cover both `open → merged` and `merged → open` with the identical base and exact two-path Candidate diff.
- Scope audit: only Task 1 runtime/release/git/coordinator code, focused tests, runtime example and this report are included. `.data` was neither read, modified, staged nor committed.

### Commit

Implementation commit: `ace70d8682f819cd6323dc19afa9b04c7eb06b87` (`fix: isolate mini program release capability`).

### Concerns

- A private runtime must point `miniProgramReleaseAdapterModule` at a Task 3-provided implementation before mini-program can become configured. The safe default remains held/disabled.

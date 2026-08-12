# Task 2 Report

Status: DONE

## Scope delivered

- Added strict `loadMiniProgramApps(config)` / `enabledMiniProgramApps` validation with own-property, plain-object, exact-field, non-blank command, duplicate identity, and non-secret reference checks.
- Froze schemaVersion 2 target plans with exact Candidate base/commit/path/mapping scope, per-task evidence, iOS Apps, mini-program Apps, Android TWA descriptor, and target DAG.
- Kept schemaVersion 1 frozen Manifest validation compatible; retries consume frozen Manifest identity and do not reconstruct it from mutable runtime configuration.
- Added the D1 all-platform forward migration as `0015_all_platform_release_targets.sql`. Task 1 already owns `0014_mini_program_production_target.sql`, so Task 2 uses the next safe migration number without changing the existing 0014.
- Added mini-program App identity, artifact digest, upload/review/release/live lineage, reconciliation evidence, Android TWA stages, exact reusable-success index, immutable-success triggers, and structural fingerprints.
- Added store-side frozen tuple validation before target insertion/retry creation.

## RED evidence

1. `node --test test/orchestration/mini-program-app-registry.test.mjs test/orchestration/version-aggregator.test.mjs`
   - Exit 1; 13 tests, 10 passed, 3 failed.
   - Expected failures: missing registry module, plan remained schemaVersion 1, Candidate scope/DAG fields absent.
2. `node --test test/orchestration/production-release-persistence.test.mjs test/orchestration/migration-runner.test.mjs`
   - Exit 1; 28 tests, 19 passed, 9 failed after test syntax correction.
   - Expected failures: missing forward migration, missing App/digest columns, old stage/index constraints, and absent frozen tuple validation.

## GREEN evidence

- `node --test test/orchestration/mini-program-app-registry.test.mjs test/orchestration/version-aggregator.test.mjs test/orchestration/production-release-persistence.test.mjs test/orchestration/migration-runner.test.mjs`
  - Exit 0; 45 tests passed, 0 failed.
- `node --test test/orchestration/release-coordinator.test.mjs test/orchestration/release-commands.test.mjs`
  - Exit 0; 25 tests passed, 0 failed.
- `git diff --check`
  - Exit 0.

## Self-review

- Verified the existing Task 1 migration is byte-for-byte unchanged.
- Verified 0015 upgrades the exact canonical 0014 schema and rejects missing indexes or same-name malformed triggers.
- Verified 0015 fails closed rather than silently dropping any legacy mini-program row whose App identity cannot be reconstructed safely.
- Verified current mini-program App ID is `wx1fdac5e27c6b5366` and runtime example stores only references, not credentials.
- Verified persisted tuples are checked against frozen DAG/App identity before D1 mutation.
- Verified no `.data` path was read, modified, staged, or deleted and no production SSH/DB, WeChat, Apple, ClickUp, or other external release side effect was invoked.

## Commit

- `efdb6fb` — `feat: persist all-platform release targets`
- `27320f3` — `fix: preserve legacy release target identity`
- The report itself is recorded in a follow-up docs-only commit because the implementation commit hash did not exist until after that commit completed.

## Concerns

- The pre-Task-2 direct production coordinator mini-program test still models mini-program as an empty-App Web-style target with `readback` terminal stage. The new frozen schema correctly rejects that legacy tuple. App-aware mini-program executor/DAG wiring belongs to the subsequent adapter/execution task; weakening the schema here would violate this Task's App identity and legal-stage requirements.

## Fix round 1/5 — DONE

### Changes

- Split the production-release migration sentinel into exact 0013, 0014, and 0015 structural states. Empty databases now apply the full ordered chain, and databases with recorded canonical 0014 advance to 0015. Existing `0014_mini_program_production_target.sql` remains unchanged.
- Made retries validate and consume the frozen Manifest only; mutable task snapshots and App registries no longer reconstruct or redefine its target tuples.
- Froze canonical `ReleaseEligibility.plannedTargets` directly, including Candidate-supplemental mini-program work, and made platform flags/DAG nodes agree exactly with that target set.
- Froze mini-program App ID, release version, version source, description, terminal success condition, and authoritative readback identity into the checksummed plan.
- Made persisted mini-program App ID immutable during updates and exact during reusable-success lookup; also tightened the coordinator's persisted mini-program identity comparison.
- Restricted credential references to bounded `.private.json` paths containing a `private` path segment, and restricted review configuration references to bounded identifiers. PEM/JWT/URL/authorization/cookie/JSON-private-key/query/fragment/control/oversize inputs fail closed without echoing their value.

### RED evidence

- `node --test test/orchestration/migration-runner.test.mjs test/orchestration/mini-program-app-registry.test.mjs test/orchestration/version-aggregator.test.mjs test/orchestration/release-coordinator.test.mjs test/orchestration/production-release-persistence.test.mjs`
  - Exit 1; 64 tests, 56 passed, 8 failed.
  - Expected failures covered empty/recorded migration sequencing, unsafe references, registry/task drift retry, missing supplemental planned target, missing frozen version/readback identity, and mutable/reusable wrong App ID.

### GREEN evidence

- `node --test test/orchestration/mini-program-app-registry.test.mjs test/orchestration/version-aggregator.test.mjs test/orchestration/production-release-persistence.test.mjs test/orchestration/migration-runner.test.mjs test/orchestration/release-coordinator.test.mjs test/orchestration/release-commands.test.mjs`
  - Exit 0; 76 passed, 0 failed.
- Wider related run including the legacy direct executor test: 96 tests, 95 passed, 1 known Task 4 seam failure.
- `git diff --check -- ':!.data'`
  - Exit 0.

### Self-review

- Confirmed per-version migration fingerprints validate the attempts table/triggers as well as the version-specific targets table/indexes/triggers.
- Confirmed the existing 0014 migration was neither modified nor replaced.
- Confirmed schemaVersion 2 canonical rebuild strips derived mini descriptor fields before registry validation and re-derives them from the frozen version tuple.
- Confirmed error messages do not contain rejected credential/reference values.
- Confirmed no `.data` path was read, modified, staged, or deleted; no production or external platform action ran.

### Commit

- Pending at report append time; recorded in the final handoff.

### Concerns

- The sole wider-run failure remains the explicitly deferred Task 4 seam: the old direct executor test constructs a mini-program target without a frozen App descriptor, which the all-platform D1 schema correctly rejects. This round did not weaken the schema or implement the Task 3 adapter/Task 4 executor migration.

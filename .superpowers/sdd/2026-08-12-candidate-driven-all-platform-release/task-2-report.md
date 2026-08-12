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
  - Exit 0; 44 tests passed, 0 failed.
- `node --test test/orchestration/release-coordinator.test.mjs test/orchestration/release-commands.test.mjs`
  - Exit 0; 25 tests passed, 0 failed.
- `git diff --check`
  - Exit 0.

## Self-review

- Verified the existing Task 1 migration is byte-for-byte unchanged.
- Verified 0015 upgrades the exact canonical 0014 schema and rejects missing indexes or same-name malformed triggers.
- Verified current mini-program App ID is `wx1fdac5e27c6b5366` and runtime example stores only references, not credentials.
- Verified persisted tuples are checked against frozen DAG/App identity before D1 mutation.
- Verified no `.data` path was read, modified, staged, or deleted and no production SSH/DB, WeChat, Apple, ClickUp, or other external release side effect was invoked.

## Commit

- `efdb6fb` — `feat: persist all-platform release targets`
- The report itself is recorded in a follow-up docs-only commit because the implementation commit hash did not exist until after that commit completed.

## Concerns

- The pre-Task-2 direct production coordinator mini-program test still models mini-program as an empty-App Web-style target with `readback` terminal stage. The new frozen schema correctly rejects that legacy tuple. App-aware mini-program executor/DAG wiring belongs to the subsequent adapter/execution task; weakening the schema here would violate this Task's App identity and legal-stage requirements.

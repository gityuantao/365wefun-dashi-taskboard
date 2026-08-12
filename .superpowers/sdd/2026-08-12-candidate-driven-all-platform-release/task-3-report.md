# Task 3 Report

Status: DONE

## Scope delivered

- Added `createWechatReleaseAdapter({ command, credentialsPath, reviewConfigurationPath, runCommand })` with one fenced method for each of `test`, `build`, `inspectArtifact`, `upload`, `readUpload`, `submitReview`, `readReview`, `release`, and `readLive`.
- Propagated the exact frozen Candidate commit/ref, Manifest checksum/version ID, App ID `wx1fdac5e27c6b5366`, release version, artifact digest/size/identity, review reference, and stable idempotency identity through an explicit child environment allowlist.
- Kept credentials as paths in the parent adapter. Private descriptor contents are loaded only inside the child stage boundary after regular-file and exact `0600` checks.
- Added bounded process execution with a detached process group, timeout and AbortSignal termination, bounded stdout/stderr, exact final-JSON parsing, typed failure classifications, and sanitization for URL credentials, Authorization/Cookie values, JWTs, private keys, control characters, and oversized text.
- Made unknown upload/review/release outcomes reconcile through their authoritative lookup stages. Nonzero exits, missing final JSON, timeouts, and explicit external-unknown failures cannot be treated as proof that the mutation did not happen.
- Required authoritative review approval before release and exact App/version/Candidate/artifact plus upload/review/release lineage at authoritative readback. Authoritative absence is represented explicitly without inventing lineage.
- Added exact detached Candidate worktree builds with mini-program lint, typecheck, tests, and production `uni build -p mp-weixin`; verified App ID, production API allowlist, absence of test/debug endpoints and secret material, deterministic artifact digest/size, safe relative paths, and cleanup on success, build failure, and setup failure.
- The standalone script is fail-closed for WeChat network stages unless a stage runner is injected. Tests use only fakes and temporary local Git repositories.

## RED evidence

1. Initial required RED:
   - `node --test test/orchestration/wechat-command-adapter.test.mjs test/orchestration/mini-program-release-script.test.mjs`
   - Exit 1; both test files failed because both production modules were missing.
2. Lifecycle/unknown/cleanup self-review RED:
   - Exit 1; 16 tests, 13 passed, 3 failed for missing authoritative approval capability, timeout lookup, and setup-failure temporary-directory cleanup.
3. Unknown result/readback self-review RED:
   - Exit 1; 11 tests, 9 passed, 2 failed for missing lookup after nonzero/malformed mutation results and incomplete authoritative lookup validation.
4. Path/absence self-review RED:
   - Exit 1; 20 tests, 18 passed, 2 failed for unbounded descriptor paths and missing authoritative-absence support.

## GREEN evidence

- Target suite: 20 passed, 0 failed.
- `node --check orchestration/mini-program/wechat-command-adapter.mjs` and `node --check scripts/release-mini-program.mjs`: exit 0.
- Related frozen descriptor/runtime suite: 40 tests, 39 passed, 1 pre-existing unrelated failure in `published cleanup resumes from the frozen manifest despite invalid runtime and registry drift`; the failing path does not import or invoke either Task 3 module.
- `git diff --check -- ':!.data'`: exit 0.
- No temporary `wechat-candidate-worktree-*` directory remained and the repository worktree registry contained only the existing main and Task 3 worktrees.

## Side-effect proof

- Every WeChat/network stage in tests uses an injected fake `runCommand` or `stageRunner`; the script has no default live WeChat runner.
- Parent adapter tests use nonexistent credential paths successfully, proving it never reads private descriptor contents.
- Child-boundary descriptor tests use only temporary fake `0600` JSON files.
- Detached build tests use temporary local Git repositories and fake `pnpm`; no dependency install, package build, or network call occurs.
- No `.data` path was read, modified, staged, or deleted. No WeChat upload/review/release, production SSH/DB, Apple, ClickUp, or other external mutation was invoked.

## Commit

- `feat: add safe mini-program release adapter` (exact hash recorded in the final handoff; this report is part of that commit).

## Concerns

- The dedicated runtime loader currently expects a future `createMiniProgramReleaseAdapter({ runtime, projectRoot })` lifecycle factory with `release/readback`. Task 3 intentionally delivers the brief's lower-level `createWechatReleaseAdapter` stage contract; Task 4 owns lifecycle composition and runtime wiring.
- The related runtime regression has one existing published-cleanup failure described above. This task does not modify that path or weaken its frozen-Manifest checks.

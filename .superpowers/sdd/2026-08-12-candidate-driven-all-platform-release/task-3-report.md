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

## Fix round 1/5 — DONE

### Reviewer findings addressed

- Split adapter inputs by stage. `test`, `build`, and `inspectArtifact` receive only frozen non-secret App identity fields, exact repository/artifact roots, and the production API allowlist. They never receive credential/review paths, idempotency data, or the full frozen descriptor containing private command/reference fields. Network stages receive only their required private references and lineage inputs.
- Candidate `pnpm` commands now cross an explicit injected sandbox contract with `network: "disabled"`, a minimal `PATH`/`LANG` environment, and a required `networkDisabled: true` proof. There is deliberately no unsandboxed fallback; real local stages fail closed without that capability. This is the isolation boundary—`0600` is only a file-permission validation and is not claimed to isolate another process running as the same user.
- Added exact adapter inputs for `repoPath`, `artifactRoot`, and `productionApiAllowlist`, and verified the actual adapter-to-CLI environment contract across all nine stages.
- Separated `test` (detached lint/typecheck/tests only) from `build` (detached production `uni build -p mp-weixin` and artifact publication only), so the nine-stage lifecycle does not duplicate validation work.
- Unclassified mutation runner failures are non-deterministic `external_unknown` in both parent adapter and child final JSON and therefore trigger authoritative lookup.
- Successful mutations now require stable stage-specific lineage: upload ID; upload/review-submission/review IDs; and upload/review/release IDs respectively.
- Worktree removal errors are no longer swallowed. Git worktree registry readback is attempted even if removal reports failure, any cleanup failure is surfaced, and owned temporary directory removal is still attempted.
- Artifact publication now copies build output to a private owned temporary directory, inspects and hashes that copy, and atomically renames the exact inspected bytes into their digest-addressed destination. Independent inspection is restricted to canonical paths inside the owned root.
- Private descriptor loading uses `O_NOFOLLOW`, then `fstat` and read on the same file descriptor. Tests cover direct symlinks and replacement of the pathname after the descriptor is opened.
- Repository, worktree artifact, and owned artifact roots are canonicalized. Root and intermediate symlinks, realpath escapes, unsafe relative paths, non-owned roots, and roots not mode `0700` fail closed.
- Production API matching now requires exact path equality or a slash boundary, so an allowlisted `/v1` accepts `/v1/...` but rejects `/v10evil`.

### RED evidence

1. Initial reviewer batch: exit 1. The suite failed for missing stage-specific environments, sandbox/private-file exports, stage lineage, and script boundary behavior.
2. Filesystem/sandbox implementation cycle: 30 tests, 16 passed and 14 failed before canonical-root and test fixture corrections.
3. Lifecycle completion cycle: 17 tests, 13 passed and 4 failed for repeated build validation, skipped registry verification after remove failure, and child mutation misclassification.
4. Canonical component/ownership cycle: 33 tests, 31 passed and 2 failed for an intermediate repository symlink and a shared-mode artifact root.
5. Owned independent-inspection cycle: 19 script tests, 18 passed and 1 failed because out-of-root artifacts were still accepted.

### GREEN evidence

- `node --test test/orchestration/wechat-command-adapter.test.mjs test/orchestration/mini-program-release-script.test.mjs`
  - Exit 0; 34 passed, 0 failed.
- `node --check orchestration/mini-program/wechat-command-adapter.mjs`
  - Exit 0.
- `node --check scripts/release-mini-program.mjs`
  - Exit 0.
- Related frozen descriptor/runtime suite: 40 tests, 39 passed, 1 unchanged pre-existing failure in `published cleanup resumes from the frozen manifest despite invalid runtime and registry drift`; neither Task 3 module participates in that failing path.
- `git diff --check -- ':!.data'`
  - Exit 0.

### Side-effect proof

- All sandbox runners, stage runners, and adapter child commands are injected fakes. Temporary local Git repositories are the only repositories mutated by tests.
- No real `pnpm`, WeChat command, network request, production SSH/DB, Apple, or ClickUp operation ran.
- Private descriptor tests use only temporary files and never claim `0600` protects against same-user processes; the security property tested is same-fd no-follow validation/read.
- No `.data` path was read, modified, staged, or removed.

### Concerns

- A real deployment must provide a sandbox runner capable of actually disabling Candidate network access and returning the explicit proof. This module intentionally supplies no portable Node fallback because Node cannot enforce that property for arbitrary subprocesses.
- Task 4 still owns composition into the runtime's `createMiniProgramReleaseAdapter({ runtime, projectRoot })` lifecycle factory.

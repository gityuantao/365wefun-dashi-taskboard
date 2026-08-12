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

## Fix round 2/5 — DONE

This round supersedes round 1's weaker `networkDisabled: true` result proof. Candidate output is no longer accepted as evidence of isolation.

### Reviewer findings addressed

- Added `createTrustedSandboxCapability(...)` as the trusted runtime injection seam. Capabilities are privately branded in the release module and carry frozen implementation/profile identity from trusted configuration; plain objects, functions, and Candidate-returned booleans are rejected.
- The sandbox execution contract now receives a read-only detached worktree, a separate private writable output root, explicit denied roots (including the agent-owned artifact root and trusted-runtime private roots), a deny-all network profile, a minimal `PATH`/`LANG`/output environment, and detached process-group requirements. The caller awaits command completion and process-group exit; on failure it invokes group termination and then drains the group before returning.
- No generic Node sandbox is claimed or supplied. CLI execution without an injected branded capability fails closed. Task 4 can compose a platform-specific trusted implementation through `createMiniProgramStageHandler({ trustedSandbox, ... })`.
- Candidate output is processed only after the trusted sandbox has completed and the process group is quiescent. Build bytes are copied with per-file `O_NOFOLLOW`, `fstat`, inode/path checks, and same-FD reads into an agent-owned `0700` temporary tree outside Candidate-writable roots. That tree becomes read-only, is inspected and hashed, and is atomically renamed within the pre-created owned storage root.
- Artifact storage must be pre-created mode `0700` by the trusted runtime. Publication parents are created one component at a time, checked for owner/canonical-root containment, and revalidated before rename. Symlink components, source replacement, intermediate-directory symlink races, and out-of-root publication fail closed.
- Worktree cleanup now runs `list`, `remove --force`, `prune`, and final registry verification whether `git worktree add` succeeds or fails. A partial-registration fake proves the add-failure path is discovered and removed; cleanup errors still fail closed after owned-directory removal is attempted.
- Replaced the adapter/CLI test that faked `executeStage` with a nine-stage local fixture that traverses the real `createWechatReleaseAdapter` → `runCli` → `validateStageInputs` → `executeMiniProgramStage` boundary, using only a branded trusted fake sandbox and fake external-stage runner.

### RED evidence

1. Trusted sandbox/interface migration: initial script run failed because the old fake returned Candidate-controlled `{ networkDisabled: true }` and the implementation had no branded lifecycle capability.
2. Immutable snapshot cycle: 19 tests, 14 passed and 5 failed while read-only tree cleanup and atomic rename permissions were incomplete.
3. Quiescence/cleanup/E2E cycle: reviewer-directed tests were added for group-exit ordering, termination on failure, partial registry registration, pre-created storage, same-FD source mutation, intermediate symlink replacement, and real nine-stage execution before their implementation was complete.

### GREEN evidence

- `node --test test/orchestration/wechat-command-adapter.test.mjs test/orchestration/mini-program-release-script.test.mjs`
  - Exit 0; 38 passed, 0 failed before the final intermediate-symlink test; the final script-only suite is 24 passed, 0 failed (therefore the final combined target is 39 tests).
- `node --check orchestration/mini-program/wechat-command-adapter.mjs`
  - Exit 0.
- `node --check scripts/release-mini-program.mjs`
  - Exit 0.
- Related frozen descriptor/runtime suite: 40 tests, 39 passed, 1 unchanged pre-existing failure in `published cleanup resumes from the frozen manifest despite invalid runtime and registry drift`; the Task 3 files are not in that failing path.
- `git diff --check`
  - Exit 0.

### Side-effect proof

- Trusted sandbox and external mutation boundaries are fakes in every test. The fake sandbox writes only to its temporary requested output root and never starts a real `pnpm` process.
- The nine-stage E2E uses temporary local Git repositories, temporary fake `0600` descriptors, and an in-process fake network runner. It performs no network request and no real WeChat action.
- No production SSH/DB, Apple, ClickUp, upload, review, or release operation ran.
- `.data` remained untracked and was not read, modified, staged, removed, or included in any verification command.

### Concerns

- A deployment still requires a platform-specific trusted sandbox implementation that can enforce the requested network namespace/profile, filesystem mount policy, and process-group lifecycle. Task 3 deliberately provides only the trusted capability contract and fail-closed loader/injection seam.
- The Candidate build tooling must honor the trusted sandbox's separate writable output mapping (`MINI_PROGRAM_BUILD_OUTPUT_DIR`) or the platform sandbox implementation must provide the equivalent mount mapping. The detached source worktree is intentionally requested read-only.

## Fix round 3/5 — DONE

This round supersedes round 2's public capability issuer and consumer-side pathname snapshot. Trust now begins at a fixed-root runtime module loader, and Candidate artifact export remains a provider responsibility.

### Reviewer findings addressed

- Removed the public sandbox capability issuer. `createTrustedMiniProgramRuntimeLoader` is now the production authority: it resolves only single-file module names beneath `projectRoot/orchestration/mini-program/sandbox-providers` and `stage-runners`, rejects absolute/traversal/nested names, rejects every symlink component, requires a current-UID regular file, rejects group/world-writable modules, and imports only after those checks. The CLI has no caller-supplied trusted root.
- Added a separate hard-coded test loader root under `test/fixtures/trusted-mini-program-runtime`; it cannot be redirected to an arbitrary temporary directory. This allows provider fixtures without making temporary paths production-authoritative.
- Added child bootstrap via `runCliMain`. Adapter environments carry only allowlisted sandbox-provider and stage-runner module names. `runCliMain` discards inherited environment keys, loads the trusted runtime, and binds the real stage handler. Without valid fixed-root modules it fails closed. A real spawned Node child traverses adapter → bootstrap → CLI validation → trusted runtime → all nine real stage handlers.
- Replaced `execute()`/promise-proof semantics with a synchronous `provider.createSession(request)` contract exposing `start`, `terminate`, `wait`, and `exportArtifact`. Tests cover session creation failure, invalid session, start/completion rejection, nonzero exit, and wait rejection. Every post-session failure attempts termination and group drain; a failed wait triggers terminate plus a second drain attempt. Failures are classified `release_infrastructure` at the child boundary.
- Removed consumer-side Candidate pathname snapshot and its same-UID TOCTOU claim. Only after session completion and process-group quiescence does the consumer call trusted `exportArtifact`. It accepts an opaque export handle with provider-owned `readFiles()` bytes plus a published evidence path. The local test provider performs `O_NOFOLLOW`, `fstat`, same-FD reads into an owned root; production safety is explicitly the provider's isolation/export contract, not `chmod` or consumer prechecks.
- Replaced the unused build-output environment variable with an explicit sandbox mount contract. The unmodified production command remains `pnpm --filter @e365/mp exec uni build -p mp-weixin`; its actual default output path `<detached worktree>/apps/mp/dist/build/mp-weixin` is mounted to the private writable output root while the detached worktree remains read-only. Tests assert exact command, source path, target path, RO/RW sets, and absence of the obsolete output env.
- Existing App ID `wx1fdac5e27c6b5366`, mutation lineage/readback, partial worktree registration cleanup, private descriptor same-FD loading, bounded JSON/redaction, and adapter stage-specific environments remain covered.

### RED evidence

1. Loader authority RED: the script test module failed to import because `trusted-runtime-loader.mjs` did not exist.
2. Provider session migration RED: the old public-capability fixtures no longer matched the desired loader-authorized runtime and export contract; the script suite failed until all local stages used the new runtime/session boundary.
3. Wait-drain RED: the lifecycle test observed only `wait-attempt`; it expected `wait-attempt`, `terminate`, and a second `wait-attempt`.
4. Adapter bootstrap RED: the adapter did not propagate allowlisted provider/runner module names.
5. Spawned CLI RED: the fixed test bootstrap did not exist, then the child rejected inherited macOS environment input before `runCliMain` filtered it to the stage allowlist.

### GREEN evidence

- `node --test test/orchestration/wechat-command-adapter.test.mjs test/orchestration/mini-program-release-script.test.mjs`
  - Exit 0; 41 passed, 0 failed. This includes the actual spawned-child nine-stage E2E.
- Syntax checks for the adapter, trusted loader, release script, and test bootstrap: all exit 0.
- Related frozen descriptor/runtime suite: 40 tests, 39 passed, 1 unchanged pre-existing failure in `published cleanup resumes from the frozen manifest despite invalid runtime and registry drift`; Task 3 modules are not in that failing path.
- `git diff --check`: exit 0.

### Side-effect proof

- The spawned E2E uses only the hard-coded repository test provider/stage-runner fixtures, temporary fake `0600` descriptor files, a temporary local Git repository, and local Node child processes. The provider does not spawn `pnpm` or make network requests.
- Production provider and stage-runner modules are deliberately absent; the default production CLI therefore fails closed until Task 4 supplies reviewed fixed-root implementations.
- No real WeChat upload/review/release, network request, production SSH/DB, Apple, or ClickUp operation ran.
- `.data` remained untracked and was not read, modified, staged, removed, or included in verification.

### Concerns

- Task 4 must provide a reviewed platform-specific provider whose mount/network/process-group/export guarantees are implemented below the ordinary same-UID Node pathname boundary. Task 3 defines and tests the consumer contract but does not claim that Node alone supplies those guarantees.
- The platform provider must map the default uni output path to the private writable target exactly as requested. If its sandbox cannot supply that mount, local build remains fail closed.

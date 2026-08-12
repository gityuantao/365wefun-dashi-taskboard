# Candidate-Driven All-Platform Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one explicitly confirmed Dashboard publish click freeze and release exactly the Web/API, Android TWA, all-enabled-iOS, and WeChat mini-program targets proven by the Candidate, while readiness alone remains side-effect free.

**Architecture:** A single release-eligibility service combines accepted task evidence with an exact Candidate/base diff and produces the immutable `productionTargetPlan` consumed by Dashboard, publish API, Manifest freeze, and recovery. The existing fenced production coordinator is extended with config-driven mini-program and optional Android TWA targets, while database migration and business smoke checks become explicit pre-client-release stages. Production adapters remain lazy and unreachable until an authorized publish outbox is consumed.

**Tech Stack:** Node.js ESM, D1/SQLite migrations, Git CLI, `node:test`, React/TypeScript/Vite, pnpm monorepo, uni-app `mp-weixin`, WeChat mini-program CI/API adapter, existing SSH/Xcode/ASC production adapters.

## Global Constraints

- Release readiness only displays an enabled publish action; it never creates an outbox, Manifest, attempt, network request, migration, upload, review submission, or production deployment.
- One authorized `release_manager|admin` Dashboard click with exact version confirmation is the complete authorization for every target frozen into that release; no second confirmation is required.
- Mini-program review approval automatically triggers formal release and authoritative readback.
- Platform scope comes from current accepted task evidence plus exact frozen Candidate/base changes; mutable worktrees and free-text keyword inference are not release authority.
- Ordinary Web changes are delivered through the Android TWA and do not create an Android artifact; only TWA wrapper/build-input changes create `android_twa`.
- Any unsupported native Android or unidentified release path fails closed before production effects.
- All enabled iOS Apps are required whenever iOS is present; future Apps join through registry configuration only.
- Database backup/migration and production business smoke tests can run only after an authorized publish outbox is consumed.
- Implementation, automated tests, dry-runs, reviews, and runtime verification must use fakes/local fixtures and must not SSH to production, migrate production DB, upload, submit review, or publish to WeChat/Apple.
- Secrets and private descriptor contents never enter Git, D1, logs, ClickUp comments, API responses, Dashboard state, test output, or child-process arguments.
- Every behavior change follows observed RED → minimal GREEN → focused verification → independent review → commit.

---

### Task 1: Exact Candidate scope and one release-eligibility result

**Files:**
- Create: `orchestration/release/candidate-scope.mjs`
- Create: `orchestration/release/release-eligibility.mjs`
- Modify: `orchestration/release/release-scope.mjs`
- Modify: `orchestration/release/platform-gate.mjs`
- Modify: `orchestration/release/version-aggregator.mjs`
- Modify: `orchestration/application/release-coordinator.mjs`
- Modify: `orchestration/dashboard/queries.mjs`
- Create: `test/orchestration/candidate-scope.test.mjs`
- Create: `test/orchestration/release-eligibility.test.mjs`
- Modify: `test/orchestration/release-scope.test.mjs`
- Modify: `test/orchestration/version-aggregator.test.mjs`
- Modify: `test/orchestration/dashboard.test.mjs`

**Interfaces:**
- Produces `classifyCandidateChanges({ repoPath, baseCommit, candidateCommit, runGit }): CandidateScope`.
- Produces `buildReleaseEligibility({ version, tasks, blockers, platformEvidence, candidateScope, configuredTargets, runtimeReadiness }): ReleaseEligibility`.
- `CandidateScope` contains `{ baseCommit, candidateCommit, mappingVersion, changedPaths, platforms, unsupported }` where platforms include `web|api|ios|mini_program|android_twa`.
- `ReleaseEligibility` contains one canonical `{ ready, gaps, taskIds, taskPlatforms, candidateScope, plannedTargets }` used unchanged by card/detail/API/freeze.

- [ ] **Step 1: Write Candidate classification RED tests**

Use a real temporary Git repository and assert: `apps/mp/**` requires `mini_program`; `apps/ios/**` requires `ios`; API/DB paths require `api`; plain `apps/web/**` requires `web` but not Android; `apps/android-web-wrapper/**` requires `android_twa`; `apps/android/**` yields unsupported `android_native`; invalid/missing/non-ancestor SHAs fail closed.

- [ ] **Step 2: Run RED**

Run: `node --test test/orchestration/candidate-scope.test.mjs`

Expected: `ERR_MODULE_NOT_FOUND` for `candidate-scope.mjs`.

- [ ] **Step 3: Implement the minimal deterministic classifier**

Run only allowlisted Git commands against explicit `repoPath`, validate both 40-character commits, prove base ancestry, return sorted normalized paths, and use a versioned exact path-rule table. Do not read the current checkout diff.

- [ ] **Step 4: Write unified eligibility RED tests**

Assert the Dashboard card and version detail share the same object/ready value; 38/38 alone stays not-ready when a gap exists; Candidate `apps/mp` supplements missing task scope; claimed independent-client scope without matching Candidate evidence produces drift; Android TWA projection is correct; unsupported native Android blocks; missing `86d40ejq2` evidence remains closed.

- [ ] **Step 5: Run eligibility RED**

Run: `node --test test/orchestration/release-eligibility.test.mjs test/orchestration/dashboard.test.mjs test/orchestration/version-aggregator.test.mjs`

Expected: card/detail disagree and mini-program remains unsupported.

- [ ] **Step 6: Implement and connect one eligibility result**

Replace independent readiness calculations with `buildReleaseEligibility`; preserve source/evidence/accepted commit per task; supplement missing task scope from exact per-task accepted PR changes when available and from Candidate scope only as an auditable version target, never by free text.

- [ ] **Step 7: Verify and commit**

```bash
node --test test/orchestration/candidate-scope.test.mjs test/orchestration/release-eligibility.test.mjs test/orchestration/release-scope.test.mjs test/orchestration/version-aggregator.test.mjs test/orchestration/dashboard.test.mjs
git add orchestration/release orchestration/application/release-coordinator.mjs orchestration/dashboard/queries.mjs test/orchestration
git commit -m "feat: derive release eligibility from candidate"
```

---

### Task 2: Freeze complete target identity and extend persistence

**Files:**
- Modify: `orchestration/release/version-aggregator.mjs`
- Modify: `orchestration/application/release-commands.mjs`
- Create: `orchestration/mini-program/app-registry.mjs`
- Modify: `orchestration/runtime.example.json`
- Create: `cloud/migrations/0014_all_platform_release_targets.sql`
- Modify: `orchestration/persistence/migrations.mjs`
- Modify: `orchestration/application/production-release-store.mjs`
- Create: `test/orchestration/mini-program-app-registry.test.mjs`
- Modify: `test/orchestration/version-aggregator.test.mjs`
- Modify: `test/orchestration/production-release-persistence.test.mjs`
- Modify: `test/orchestration/migration-runner.test.mjs`

**Interfaces:**
- Extends `productionTargetPlan` with exact base/Candidate scope, `miniProgramApps`, `androidTwa`, DAG, mapping version, and per-task evidence.
- Produces `loadMiniProgramApps(config)` with strict plain/own-property validation and non-secret references only.
- Extends target platforms to `web|api|ios|mini_program|android_twa` and legal mini-program stages `test|build|artifact|upload|review_submit|review_wait|release|live_readback`.

- [ ] **Step 1: Write registry and Manifest RED tests**

Require `id,name,enabled,appId,sourceDirectory,buildCommand,artifactDirectory,uploadCommand,reviewCommand,releaseCommand,readbackCommand,credentialsPath,reviewConfigurationRef`; reject inherited/blank/duplicate/unsupported values; prove current App ID `wx1fdac5e27c6b5366`; assert Manifest checksum changes for any path, App, DAG, or mapping drift.

- [ ] **Step 2: Run RED**

Run: `node --test test/orchestration/mini-program-app-registry.test.mjs test/orchestration/version-aggregator.test.mjs`

Expected: missing registry and target-plan fields.

- [ ] **Step 3: Write real-D1 schema RED tests**

Require mini-program/App identity, artifact digest, upload/review/release/live IDs, reconciliation, terminal evidence, immutable-success trigger, and exact reusable-success index. Require a structural migration sentinel that rejects partial or same-name malformed schema.

- [ ] **Step 4: Run schema RED**

Run: `node --test test/orchestration/production-release-persistence.test.mjs test/orchestration/migration-runner.test.mjs`

Expected: platform CHECK and stage constraints reject mini-program targets.

- [ ] **Step 5: Implement registry, frozen plan, migration, and store tuple validation**

Use additive migration/rebuild conventions supported by D1, validate every persisted target against the frozen plan, and never reconstruct identity from mutable runtime configuration during retry.

- [ ] **Step 6: Verify and commit**

```bash
node --test test/orchestration/mini-program-app-registry.test.mjs test/orchestration/version-aggregator.test.mjs test/orchestration/production-release-persistence.test.mjs test/orchestration/migration-runner.test.mjs
git add orchestration/mini-program orchestration/runtime.example.json orchestration/release/version-aggregator.mjs orchestration/application/release-commands.mjs orchestration/application/production-release-store.mjs cloud/migrations orchestration/persistence/migrations.mjs test/orchestration
git commit -m "feat: persist all-platform release targets"
```

---

### Task 3: Safe mini-program build and command adapter

**Files:**
- Create: `orchestration/mini-program/wechat-command-adapter.mjs`
- Create: `scripts/release-mini-program.mjs`
- Create: `test/orchestration/wechat-command-adapter.test.mjs`
- Create: `test/orchestration/mini-program-release-script.test.mjs`

**Interfaces:**
- Produces `createWechatReleaseAdapter({ command, credentialsPath, reviewConfigurationPath, runCommand })`.
- Adapter exposes one fenced operation per stage: `test`, `build`, `inspectArtifact`, `upload`, `readUpload`, `submitReview`, `readReview`, `release`, `readLive`.
- Script consumes only allowlisted stage inputs and emits exactly one bounded final JSON object.

- [ ] **Step 1: Write command-boundary RED tests**

Assert exact Candidate/app/version/digest propagation, no parent environment forwarding, timeout and AbortSignal process-group termination, nonzero/final-JSON handling, typed classifications, and redaction of URL credentials, Authorization, Cookie, JWT, private-key fragments, control characters, and oversized output.

- [ ] **Step 2: Write detached-build RED tests**

Using a temporary fixture repo, require exact detached Candidate worktree, `pnpm --filter @e365/mp lint`, typecheck/tests, production `uni build -p mp-weixin`, App ID match, production API allowlist, absence of test/debug endpoints and secrets, deterministic artifact digest/size, and guaranteed worktree cleanup.

- [ ] **Step 3: Run RED**

Run: `node --test test/orchestration/wechat-command-adapter.test.mjs test/orchestration/mini-program-release-script.test.mjs`

Expected: both production modules are missing.

- [ ] **Step 4: Implement local stages and abstract WeChat protocol**

Keep real network operations behind injected stage runners/commands. Load private descriptors only inside the child boundary, require 0600 regular files, compare descriptor App ID with frozen plan, and return minimal sanitized evidence.

- [ ] **Step 5: Implement upload/review/release/readback contracts**

Every mutation receives stable idempotency identity and must support authoritative lookup after unknown outcome. Review-approved leads to release capability; `readLive` must close App ID/version/upload-review-release identity without trusting request echoes.

- [ ] **Step 6: Verify and commit**

```bash
node --test test/orchestration/wechat-command-adapter.test.mjs test/orchestration/mini-program-release-script.test.mjs
node --check orchestration/mini-program/wechat-command-adapter.mjs
node --check scripts/release-mini-program.mjs
git add orchestration/mini-program scripts/release-mini-program.mjs test/orchestration
git commit -m "feat: add safe mini-program release adapter"
```

---

### Task 4: Fenced mini-program lifecycle and automatic post-review release

**Files:**
- Modify: `orchestration/application/production-release-coordinator.mjs`
- Modify: `orchestration/application/production-release-store.mjs`
- Modify: `orchestration/application/release-commands.mjs`
- Modify: `orchestration/application/release-coordinator.mjs`
- Create: `test/orchestration/mini-program-production-release.test.mjs`
- Modify: `test/orchestration/production-release-coordinator.test.mjs`
- Modify: `test/orchestration/release-commands.test.mjs`

**Interfaces:**
- `executeProductionRelease` consumes frozen mini-program descriptors and `miniProgramAdapter`.
- Returns `waiting_external` during review; automatically performs `release` after authoritative approval under the original publish authorization.

- [ ] **Step 1: Write lifecycle RED tests**

Cover stage order, persistence before each effect, upload unknown → GET-only recovery, review unknown → GET-only recovery, multi-tick review waiting, rejection=`product_rework`, approval → automatic release without a new command, exact live success, and no aggregate publication until all targets succeed.

- [ ] **Step 2: Write recovery/fencing RED tests**

Cover crash with a fresh adapter instance, lease takeover between stages, stale holder blocked before/after effect, historical success immutable reuse, failed-target-only retry, and no Web/API/iOS replay after mini-program failure.

- [ ] **Step 3: Run RED**

Run: `node --test test/orchestration/mini-program-production-release.test.mjs test/orchestration/production-release-coordinator.test.mjs test/orchestration/release-commands.test.mjs`

Expected: mini-program target is rejected or ignored.

- [ ] **Step 4: Implement config-driven target handlers**

Add mini-program handler without country/App-specific branches, persist every identity before advancing, require authoritative evidence for waiting/success, and count bounded ambiguous observations before deterministic failure.

- [ ] **Step 5: Verify and commit**

```bash
node --test test/orchestration/mini-program-production-release.test.mjs test/orchestration/production-release-coordinator.test.mjs test/orchestration/release-commands.test.mjs test/orchestration/release-coordinator.test.mjs
git add orchestration/application test/orchestration
git commit -m "feat: coordinate mini-program production release"
```

---

### Task 5: Authorized database migration, release DAG, and business smoke gates

**Files:**
- Create: `orchestration/release/production-dag.mjs`
- Modify: `orchestration/release/production-command-adapter.mjs`
- Modify: `scripts/deploy-production-candidate.mjs`
- Modify: `orchestration/application/production-release-coordinator.mjs`
- Modify: `orchestration/runtime.example.json`
- Create: `test/orchestration/production-dag.test.mjs`
- Modify: `test/orchestration/production-command-adapter.test.mjs`
- Modify: `test/orchestration/production-deployment-script.test.mjs`
- Modify: `test/orchestration/production-release-coordinator.test.mjs`

**Interfaces:**
- Produces frozen ordered DAG: `preflight → db_backup → db_expand → api → web → android_twa? → ios/mini_program → live_readback → publish → cleanup`.
- Web/API adapter gains fenced `backupDatabase`, `inspectMigrations`, `applyExpandMigrations`, and `businessReadback` stages.
- Business smoke definitions are frozen non-secret Manifest inputs.

- [ ] **Step 1: Write authorization/DAG RED tests**

Assert no valid publish command means zero adapter imports/effects; authorized command freezes exact DAG; DB stages precede API/Web/client targets; failure stops downstream; retry reuses successful backup/migration evidence only when exact Candidate/schema identity matches.

- [ ] **Step 2: Write migration safety RED tests**

With fake PostgreSQL/Prisma runners, require verified custom-format backup, checksum/size, `prisma migrate status`, full pending migration list, Expand compatibility classification, deploy result, post-schema verification, and no automatic DB rollback. Missing/Contract/destructive ambiguity fails before apply.

- [ ] **Step 3: Write business-smoke RED tests**

Reproduce the incident: infrastructure health is 200 while quick-lesson endpoints return 500 because category columns are absent. Require all declared v1.0.3 quick-lesson endpoints and daily-course read endpoints to be 200 with structurally nonempty data before Web/API success; failed smoke restores old entry and blocks client release.

- [ ] **Step 4: Run RED**

Run: `node --test test/orchestration/production-dag.test.mjs test/orchestration/production-command-adapter.test.mjs test/orchestration/production-deployment-script.test.mjs test/orchestration/production-release-coordinator.test.mjs`

Expected: current deployment succeeds on basic health and lacks DB stages.

- [ ] **Step 5: Implement frozen DAG and fenced stages**

Keep every real command lazy behind authorized coordinator ownership. Parse only bounded final JSON, persist stage evidence, preserve the old current link until business gates pass, and restore it on post-switch failure.

- [ ] **Step 6: Verify and commit**

```bash
node --test test/orchestration/production-dag.test.mjs test/orchestration/production-command-adapter.test.mjs test/orchestration/production-deployment-script.test.mjs test/orchestration/production-release-coordinator.test.mjs
git add orchestration/release orchestration/application/production-release-coordinator.mjs orchestration/runtime.example.json scripts/deploy-production-candidate.mjs test/orchestration
git commit -m "feat: gate production release on migrations and business health"
```

---

### Task 6: One-click authorization and consistent Dashboard UX

**Files:**
- Modify: `orchestration/dashboard/queries.mjs`
- Modify: `orchestration/dashboard/http-server.mjs`
- Modify: `orchestration/dashboard/release-api.mjs`
- Modify: `cloud/src/dashboard-routes.mjs`
- Modify: `server/app.mjs`
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/components/dashboard/VersionProgress.tsx`
- Modify: `web/src/components/dashboard/DetailDrawer.tsx`
- Modify: `web/src/components/dashboard/ReleaseActions.tsx`
- Modify: `web/src/components/dashboard/dashboard.css`
- Modify: `test/dashboard-api.test.mjs`
- Modify: `test/dashboard-components.test.mjs`
- Modify: `test/dashboard-dialog.test.mjs`
- Modify: `test/orchestration/dashboard.test.mjs`
- Modify: `test/orchestration/dashboard-http.test.mjs`
- Modify: `test/server-dashboard-proxy.test.mjs`

**Interfaces:**
- Card/detail both consume serialized `ReleaseEligibility`.
- Publish body remains `{ confirmationVersion, requestId }`; server-derived actor must have `release_manager|admin`.
- A successful click creates exactly one CAS-bound `releasing` outbox that represents complete authorization.

- [ ] **Step 1: Write inconsistent-readiness RED test**

Fixture 38/38 ready with mini-program/config gap; assert card is not labeled publishable and detail has the identical gap codes/targets.

- [ ] **Step 2: Write authorization RED tests**

Assert no click across poll intervals creates zero outbox/attempt/import; malformed/unauthorized/stale-version/stale-state requests write nothing; one valid click writes one stable outbox; repeated identical request returns it; a second request cannot duplicate release.

- [ ] **Step 3: Write UI RED tests**

Require Candidate/base, task count, DB migration warning, Web/API, Android TWA conditional target, all iOS Apps, mini-program App ID/version, and “审核通过后自动发布” text. Exact version input and one button complete confirmation; no second-confirmation control exists. Preserve alertdialog focus trap/Escape/return focus.

- [ ] **Step 4: Run RED**

Run: `pnpm test:dashboard && node --test test/orchestration/dashboard.test.mjs test/orchestration/dashboard-http.test.mjs test/server-dashboard-proxy.test.mjs`

Expected: card still derives readiness from task count and mini-program target is absent.

- [ ] **Step 5: Implement shared serialization and UI**

Render structured gap labels, evidence sources, target progress, reconciliation/readback timestamps, safe failure summaries, and failed-step retry. Never expose raw Manifest, private refs, or platform responses.

- [ ] **Step 6: Verify and commit**

```bash
pnpm test:dashboard
pnpm typecheck
pnpm build:web
node --test test/orchestration/dashboard.test.mjs test/orchestration/dashboard-http.test.mjs test/server-dashboard-proxy.test.mjs
git add orchestration/dashboard cloud/src/dashboard-routes.mjs server/app.mjs web/src test test/orchestration
git commit -m "feat: confirm complete all-platform releases"
```

---

### Task 7: Runtime wiring and strict no-click/no-effect boundary

**Files:**
- Modify: `scripts/orchestrator.mjs`
- Modify: `orchestration/production-runtime.mjs`
- Modify: `orchestration/runtime.example.json`
- Modify: `test/orchestration/production-runtime-wiring.test.mjs`
- Modify: `test/orchestration/orchestrator-lifecycle.test.mjs`
- Modify: `test/orchestration/tick-recovery.test.mjs`

**Interfaces:**
- Runtime exposes side-effect-free `probeReadiness()` separately from lazy `createAdaptersForAuthorizedRelease()`.
- Production adapters can be created only for an exact persisted authorized release command/Manifest tuple.

- [ ] **Step 1: Write no-click RED tests**

Across startup, readiness probe, task transitions to ready, all-ready version, poll intervals, master resume, and process restart, assert adapter imports/factories/commands remain zero without an authorized release command.

- [ ] **Step 2: Write authorized-resume RED tests**

Assert valid command creates adapters only after frozen-plan verification; waiting review resumes GET-only after restart; master pause blocks new effects; loss of lease aborts process tree; published cleanup does not require current registry/runtime drift to match.

- [ ] **Step 3: Run RED**

Run: `node --test test/orchestration/production-runtime-wiring.test.mjs test/orchestration/orchestrator-lifecycle.test.mjs test/orchestration/tick-recovery.test.mjs`

Expected: readiness/factory boundary is not bound to authorization tuple.

- [ ] **Step 4: Implement strict lazy wiring**

Keep readiness structural and side-effect free, validate private paths without reading secret contents into result, and pass exact frozen Web/iOS/mini-program descriptors only inside coordinator ownership.

- [ ] **Step 5: Verify and commit**

```bash
node --test test/orchestration/production-runtime-wiring.test.mjs test/orchestration/orchestrator-lifecycle.test.mjs test/orchestration/tick-recovery.test.mjs
git add scripts/orchestrator.mjs orchestration/production-runtime.mjs orchestration/runtime.example.json test/orchestration
git commit -m "fix: require publish authorization for production effects"
```

---

### Task 8: Full fake E2E, security review, documentation, and side-effect-free runtime acceptance

**Files:**
- Modify: `test/orchestration/mvp-e2e.test.mjs`
- Modify: `test/orchestration/production-release-security.test.mjs`
- Create: `test/orchestration/all-platform-release-e2e.test.mjs`
- Modify: `docs/开发记录.md`
- Modify: `.superpowers/sdd/2026-08-12-candidate-driven-all-platform-release/progress.md`
- Create: `.superpowers/sdd/2026-08-12-candidate-driven-all-platform-release/task-8-report.md`

**Interfaces:**
- One assembled test covers Dashboard click → outbox → Candidate/Manifest → DB/API/Web → all iOS + mini-program → automatic post-review release → publication → cleanup.

- [ ] **Step 1: Write assembled E2E before any production runtime verification**

Use real D1/state-machine code and fake Git/platform/process boundaries. Prove: no-click zero effects; exact v1.0.3-shaped scope includes `apps/mp`; one click; DB backup/migration; API/Web business gates; all iOS; mini-program multi-tick approval and automatic release; all-target publication; cleanup compensation; every mutation called exactly once.

- [ ] **Step 2: Add failure/recovery matrix**

Cover unsupported native Android, missing task evidence, Candidate drift, migration failure, business 500 rollback, first/second iOS failure, mini-program upload unknown, review rejection, restart wait, fencing takeover, repeated click, target-only retry, private-config drift, and success-row immutability.

- [ ] **Step 3: Add sink-by-sink security assertions**

Inject hostile credentials/control/oversize payloads through Web, iOS, mini-program and DB stages; assert raw D1, result, logs, ClickUp comments, Dashboard/API and final report contain none. Assert strict identities fail closed instead of being redacted into equality.

- [ ] **Step 4: Run focused and full verification**

```bash
node --test test/orchestration/all-platform-release-e2e.test.mjs test/orchestration/mvp-e2e.test.mjs test/orchestration/production-release-security.test.mjs
pnpm test:orchestration
pnpm test:dashboard
pnpm typecheck
pnpm build
node --check scripts/orchestrator.mjs
node --check scripts/deploy-production-candidate.mjs
node --check scripts/release-all-ios-apps.mjs
node --check scripts/release-mini-program.mjs
git diff --check
```

Expected: all release-focused and complete orchestration/dashboard suites pass; builds/checks exit 0. Any unrelated pre-existing full-suite failure is recorded with exact test and proven non-overlap, never hidden or skipped.

- [ ] **Step 5: Perform independent final review**

Review against the approved spec with explicit verdict for authorization boundary, Candidate identity, platform completeness, DB safety, WeChat/iOS recovery, fencing, secret sinks, and zero real side effects. Resolve every Critical/Important through new RED → GREEN before proceeding.

- [ ] **Step 6: Commit source documentation**

```bash
git add test/orchestration docs/开发记录.md
git commit -m "test: verify candidate-driven all-platform release"
```

- [ ] **Step 7: Run local side-effect-free runtime acceptance**

Keep production release hold enabled and do not create private WeChat production credentials if absent. Restart only the orchestrator child, preserve supervisor, verify Dashboard endpoints, confirm card/detail identical readiness, wait across at least one poll interval, and prove no new release outbox/attempt/SSH/DB migration/upload/review/release activity. Do not click publish.

- [ ] **Step 8: Update customer records and validate structure**

Update `docs/开发记录.md`, `沟通记录/当前沟通.md`, `沟通记录/交接摘要.md`, and `沟通记录/完整沟通记录-2026-08-12.md`; place sanitized evidence under `资料/分析输出/`; run:

```bash
python3 00_总览/工具/project_mgmt.py validate-structure
```

Expected: exit 0 and zero ERROR.

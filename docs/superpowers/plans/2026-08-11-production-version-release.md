# Production Version Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the existing version publish button and frozen-Candidate release state machine to deterministic Web/API production deployment and all-enabled-iOS App Store review, automatic release, and live-version readback.

**Architecture:** The existing frozen release manifest remains the immutable root of truth. A production release coordinator persists one version attempt plus per-platform/per-App stages, calls a production Web adapter and a registry-driven App Store adapter under fenced leases, and resumes only unfinished work after crashes or partial failure. The dashboard submits an authorized, version-number-confirmed idempotent request and renders persisted stage evidence; it cannot bypass gates or force success.

**Tech Stack:** Node.js ESM, D1/SQLite, `node:test`, Git CLI, SSH/rsync production deployment, Xcode/App Store Connect CLI integration, React/TypeScript dashboard, Vitest/Vite.

## Global Constraints

- A version becomes `published` only after Web/API and every enabled iOS App are authoritatively live on the frozen Candidate/version.
- Apple review approval must trigger immediate automatic App Store release.
- Successful platforms are not rolled back because another platform fails; retries compensate only unfinished or invalidated platform stages.
- Any Android or mini-program impact fails closed before external release effects.
- Future enabled iOS Apps join through configuration only; no country-specific branches.
- No AI model makes production release decisions.
- No secret may enter Git, D1, logs, ClickUp comments, API responses, or dashboard state.
- Implementation and automated tests must not deploy production, upload a real App, submit App Review, or mutate live ClickUp/D1.
- Every production change follows observed RED → minimal GREEN → focused tests → commit.

---

### Task 1: Production release registry, platform gate, and persistence schema

**Files:**
- Modify: `orchestration/ios/app-registry.mjs`
- Create: `orchestration/runtime.example.json`
- Create: `orchestration/release/platform-gate.mjs`
- Create: `cloud/migrations/0013_production_release_attempts.sql`
- Modify: `orchestration/persistence/migrations.mjs`
- Test: `test/orchestration/ios-app-registry.test.mjs`
- Create: `test/orchestration/production-platform-gate.test.mjs`
- Create: `test/orchestration/production-release-persistence.test.mjs`
- Modify: `test/orchestration/migration-runner.test.mjs`

**Interfaces:**
- Produces `loadIosApps(config)` entries with required own non-secret fields `appStoreAppId`, `releaseMode`, and `reviewConfigurationRef`.
- Produces `resolveProductionPlatforms(taskSnapshots): { web: boolean, api: boolean, ios: boolean, unsupported: string[] }`.
- Produces `production_release_attempts` and `production_release_targets` tables keyed by exact version/Candidate/manifest/platform/App identity.

- [ ] **Step 1: Write failing registry and platform-gate tests**

Assert missing/inherited/blank release fields fail, `releaseMode` accepts only `automatic`, a third enabled App is returned without country branching, explicit Web/API/iOS aggregate correctly, and Android/mini-program appear in `unsupported`.

- [ ] **Step 2: Verify RED**

Run: `node --test test/orchestration/ios-app-registry.test.mjs test/orchestration/production-platform-gate.test.mjs`

Expected: release fields and `resolveProductionPlatforms` are absent.

- [ ] **Step 3: Write failing migration/persistence tests**

Require version attempt identity, per-target identity, stage/status CHECK constraints, timestamps, idempotency key, external request/upload/review/live identifiers, sanitized observed evidence, failure fingerprint, and indexes for latest target and reusable success.

- [ ] **Step 4: Verify migration RED**

Run: `node --test test/orchestration/production-release-persistence.test.mjs test/orchestration/migration-runner.test.mjs`

Expected: migration `0013` sentinel/tables are missing.

- [ ] **Step 5: Implement registry, platform gate, and schema**

Use strict own-property/plain-object validation. Store only non-secret configuration references. Define explicit stage sets covering Web preflight/upload/switch/health/readback and iOS test/archive/upload/processing/review_submit/review_wait/release/live_readback.

- [ ] **Step 6: Verify GREEN and commit**

```bash
node --test test/orchestration/ios-app-registry.test.mjs test/orchestration/production-platform-gate.test.mjs test/orchestration/production-release-persistence.test.mjs test/orchestration/migration-runner.test.mjs
git add orchestration/ios/app-registry.mjs orchestration/release/platform-gate.mjs orchestration/runtime.example.json cloud/migrations/0013_production_release_attempts.sql orchestration/persistence/migrations.mjs test/orchestration
git commit -m "feat: define production release targets"
```

---

### Task 2: Persistent release target lifecycle and fenced recovery

**Files:**
- Create: `orchestration/application/production-release-store.mjs`
- Create: `orchestration/application/production-release-coordinator.mjs`
- Modify: `orchestration/application/release-commands.mjs`
- Modify: `orchestration/application/release-coordinator.mjs`
- Test: `test/orchestration/production-release-coordinator.test.mjs`
- Modify: `test/orchestration/release-commands.test.mjs`
- Modify: `test/orchestration/release-coordinator.test.mjs`

**Interfaces:**
- Produces `executeProductionRelease({ db, manifest, platforms, apps, webAdapter, iosAdapter, lease, now })`.
- Produces terminal result `completed | waiting_external | failed`, with per-target evidence.
- Consumes the existing immutable Manifest; never recomputes it during retry.

- [ ] **Step 1: Write failing lifecycle tests**

Cover: Web + two iOS sequential targets; version remains releasing while any target waits; no task/version publish before all live; partial success reused; failed target only retried; crash after external success performs readback before retry; stale fencing token blocks the next external effect.

- [ ] **Step 2: Verify RED**

Run: `node --test test/orchestration/production-release-coordinator.test.mjs`

Expected: coordinator/store imports are missing.

- [ ] **Step 3: Implement store and coordinator**

Insert immutable attempt/target rows, acquire and renew a version-scoped release lease, persist stage transitions before external calls, and record separate observation attempts without rewriting historical success. `waiting_external` is not `release_failed`; deterministic rejection or exhausted safe retry is.

- [ ] **Step 4: Connect existing version state machine**

Replace the one-shot `adapter.release/readback` assumption with the persistent coordinator. Dispatch `release_succeeded` and publish tasks only after aggregate success. On failure dispatch one evidence-backed `release_failed`; retry reuses the frozen manifest and successful targets.

- [ ] **Step 5: Verify GREEN and commit**

```bash
node --test test/orchestration/production-release-coordinator.test.mjs test/orchestration/release-commands.test.mjs test/orchestration/release-coordinator.test.mjs
git add orchestration/application/production-release-store.mjs orchestration/application/production-release-coordinator.mjs orchestration/application/release-commands.mjs orchestration/application/release-coordinator.mjs test/orchestration
git commit -m "feat: persist production release lifecycle"
```

---

### Task 3: Real Web/API production release adapter

**Files:**
- Create: `orchestration/release/production-command-adapter.mjs`
- Create: `scripts/deploy-production-candidate.mjs`
- Modify: `orchestration/release/adapters/web.mjs`
- Create: `test/orchestration/production-command-adapter.test.mjs`
- Create: `test/orchestration/production-deployment-script.test.mjs`
- Modify: `test/orchestration/web-adapter.test.mjs`

**Interfaces:**
- Produces tracked `createReleaseAdapter({ runtime, projectRoot })`.
- Adapter methods: `collectRegressionEvidence`, `identifyArtifact`, `release`, `readback`.
- Stage command consumes a strict allowlisted environment containing frozen Candidate/manifest/release identity and non-secret config paths.

- [ ] **Step 1: Write failing adapter contract tests**

Assert exact Candidate/manifest/artifact propagation, final-JSON-only parsing, nonzero exit handling, timeout/abort behavior, sanitized errors, and no parent-environment credential forwarding.

- [ ] **Step 2: Verify RED**

Run: `node --test test/orchestration/production-command-adapter.test.mjs test/orchestration/web-adapter.test.mjs`

Expected: production adapter is missing.

- [ ] **Step 3: Write failing deployment-layout tests**

Statically/behaviorally require immutable release directory, explicit traversable modes, shared production env link, build/install command allowlist, atomic current-entry switch, rollback-safe previous entry, public/admin/API health, DB/Redis ready, and authoritative production state file containing Candidate/artifact/release identity.

- [ ] **Step 4: Implement command adapter and deployment script**

Reuse the staging deployment layout utilities where safe, but use separate production hosts/paths/URLs and never accept staging defaults. The script must fail before switching if preflight/upload/build fails; after switching, failed health restores the prior entry and records both observations.

- [ ] **Step 5: Verify GREEN and commit**

```bash
node --test test/orchestration/production-command-adapter.test.mjs test/orchestration/production-deployment-script.test.mjs test/orchestration/web-adapter.test.mjs
git add orchestration/release/production-command-adapter.mjs orchestration/release/adapters/web.mjs scripts/deploy-production-candidate.mjs test/orchestration
git commit -m "feat: deploy frozen candidates to production"
```

---

### Task 4: App Store review, automatic release, and live readback adapter

**Files:**
- Create: `orchestration/ios/app-store-release-adapter.mjs`
- Create: `scripts/release-all-ios-apps.mjs`
- Reuse/modify: `scripts/stage-all-ios-apps.mjs` only by extracting shared safe build primitives; do not weaken TestFlight behavior
- Create: `test/orchestration/app-store-release-adapter.test.mjs`
- Create: `test/orchestration/ios-production-release-script.test.mjs`
- Modify: `test/orchestration/ios-app-registry.test.mjs`

**Interfaces:**
- Produces `stageBuild({ app, manifest })`, `submitReview({ app, build })`, `readReview({ app, submission })`, `readLive({ app, version })`.
- Returns minimal sanitized evidence: App ID, bundle, version, build, upload ID, submission ID, review state, release state, live version/build, checkedAt.

- [ ] **Step 1: Write failing adapter tests**

Assert exact env propagation, credentials only via private path, final JSON evidence, typed stages, redaction, and no duplicate upload/review when prior external evidence exists.

- [ ] **Step 2: Write failing production script tests**

Require all enabled apps in registry order; explicit production Release configuration; exact scheme/bundle/App ID/version/build; automated test target; no test API/debug hook/StoreKit fixture; processing GET; automatic release review submission; review/live GET; and third-App extensibility.

- [ ] **Step 3: Verify RED**

Run: `node --test test/orchestration/app-store-release-adapter.test.mjs test/orchestration/ios-production-release-script.test.mjs`

Expected: modules are missing.

- [ ] **Step 4: Implement deterministic App Store adapter**

Use the existing ASC private credential mechanism and identity checks. POST operations require stable idempotency identity plus pre/post authoritative GET reconciliation. Apple waiting states return `waiting_external`; rejected/invalid states return typed failure; approved state must confirm automatic release configuration; completion requires exact live-version/build readback.

- [ ] **Step 5: Verify GREEN and commit**

```bash
node --test test/orchestration/app-store-release-adapter.test.mjs test/orchestration/ios-production-release-script.test.mjs test/orchestration/ios-app-registry.test.mjs
git add orchestration/ios/app-store-release-adapter.mjs scripts/release-all-ios-apps.mjs scripts/stage-all-ios-apps.mjs test/orchestration
git commit -m "feat: automate all-app App Store release"
```

---

### Task 5: Production runtime wiring, polling, and safe configuration

**Files:**
- Modify: `scripts/orchestrator.mjs`
- Modify: `orchestration/runtime.example.json`
- Modify: `.gitignore` only if a new private runtime path requires it
- Modify: `test/orchestration/orchestrator-lifecycle.test.mjs`
- Modify: `test/orchestration/tick-recovery.test.mjs`
- Create: `test/orchestration/production-runtime-wiring.test.mjs`

**Interfaces:**
- Runtime non-secret fields identify production adapter module/commands, timeouts, hosts/URLs, and private credential/config paths.
- Release coordinator tick handles `releasing`, `release_failed` explicit retry, `waiting_external`, and published cleanup without automatic duplicate writes.

- [ ] **Step 1: Write failing production-wiring tests**

Cover missing/invalid adapter config failure before ClickUp releasing mutation, lazy module import/factory errors inside ownership evidence, master pause, lease loss, process restart, waiting-Apple polling, and explicit-only retry after deterministic failure.

- [ ] **Step 2: Verify RED**

Run: `node --test test/orchestration/production-runtime-wiring.test.mjs test/orchestration/orchestrator-lifecycle.test.mjs test/orchestration/tick-recovery.test.mjs`

Expected: current null adapter wiring rejects or lacks persistent target recovery.

- [ ] **Step 3: Implement production wiring**

Load registry and adapters at the coordinator-owned boundary. Validate required non-secret configuration before allowing the dashboard to advertise release readiness. Schedule bounded authoritative polling for Apple waiting states and renew leases around every external boundary.

- [ ] **Step 4: Verify GREEN and commit**

```bash
node --test test/orchestration/production-runtime-wiring.test.mjs test/orchestration/orchestrator-lifecycle.test.mjs test/orchestration/tick-recovery.test.mjs
git add scripts/orchestrator.mjs orchestration/runtime.example.json test/orchestration
git commit -m "feat: wire production release runtime"
```

---

### Task 6: Authorized confirmation API and release progress dashboard

**Files:**
- Modify: `cloud/src/dashboard-routes.mjs`
- Modify: `orchestration/dashboard/http-server.mjs`
- Modify: `orchestration/dashboard/queries.mjs`
- Modify: `server/app.mjs`
- Modify: `web/src/api.ts`
- Modify: `web/src/types.ts`
- Modify: `web/src/components/dashboard/DetailDrawer.tsx`
- Modify: `web/src/components/dashboard/ReleaseActions.tsx`
- Modify: `web/src/components/dashboard/dashboard.css`
- Modify: `test/dashboard-api.test.mjs`
- Modify: `test/dashboard-components.test.mjs`
- Modify: `test/dashboard-dialog.test.mjs`
- Modify: `test/orchestration/dashboard.test.mjs`
- Modify: `test/orchestration/dashboard-routes.test.mjs`
- Modify: `test/orchestration/dashboard-http.test.mjs`

**Interfaces:**
- `POST /api/orchestration/dashboard/versions/:id/publish` body: `{ confirmationVersion: string, requestId: string }`.
- Response returns non-secret release request/status; caller identity must have `release_manager|admin`.
- Version detail returns release readiness gaps and per-target safe stage/readback summaries.

- [ ] **Step 1: Write failing API tests**

Assert unauthorized/incorrect version/missing request ID/config gaps/unsupported platforms reject without mutation; identical request is idempotent; accepted request enqueues exactly one releasing mutation.

- [ ] **Step 2: Write failing UI tests**

Require confirmation dialog, exact version input, production/App Store warning, target list, disabled submission until exact match, per-platform progress, retry-failed action, and absence of force-success/skip controls.

- [ ] **Step 3: Verify RED**

Run: `pnpm test:dashboard`

- [ ] **Step 4: Implement API/query/UI changes**

Keep the Codex-desktop visual language already used by the dashboard. Never return secret paths or raw external responses. Revalidate authorization and readiness server-side; UI checks are not security boundaries.

- [ ] **Step 5: Verify GREEN and commit**

```bash
node --test test/orchestration/dashboard.test.mjs test/orchestration/dashboard-routes.test.mjs test/orchestration/dashboard-http.test.mjs
pnpm test:dashboard
git add cloud/src/dashboard-routes.mjs orchestration/dashboard server/app.mjs web/src test
git commit -m "feat: confirm and monitor production releases"
```

---

### Task 7: End-to-end failure, security, and compensation gates

**Files:**
- Modify: `test/orchestration/mvp-e2e.test.mjs`
- Create: `test/orchestration/production-release-security.test.mjs`
- Modify: `orchestration/application/production-release-coordinator.mjs` only when a new RED test demonstrates a coordinator defect
- Modify: `orchestration/application/production-release-store.mjs` only when a new RED test demonstrates a persistence defect
- Modify: `orchestration/release/production-command-adapter.mjs` only when a new RED test demonstrates a Web adapter defect
- Modify: `orchestration/ios/app-store-release-adapter.mjs` only when a new RED test demonstrates an App Store adapter defect

**Interfaces:**
- Exercises dashboard request → frozen Manifest → Web success → all-App waiting/review/live → aggregate publish → cleanup.

- [ ] **Step 1: Write end-to-end RED scenarios**

Cover two enabled Apps then a third config App; Android/mini-program block; Web failure; first-App failure short circuit; second-App rejection after Web success; unknown POST outcome reconciled by GET; restart during review wait; fencing takeover; repeated click; failed retry reusing success; exact all-live success; cleanup partial failure.

- [ ] **Step 2: Write credential-sink RED scenarios**

Inject URL credentials, Authorization, Cookie, JWT, quoted JSON keys, ASC key fragments, control characters, and oversized errors through every adapter boundary; assert none reaches D1, result, log/comment payload, or dashboard JSON.

- [ ] **Step 3: Verify RED then implement only required fixes**

Run: `node --test test/orchestration/mvp-e2e.test.mjs test/orchestration/production-release-security.test.mjs`

Expected: newly asserted full path/security cases fail before fixes.

- [ ] **Step 4: Verify GREEN and commit**

```bash
node --test test/orchestration/mvp-e2e.test.mjs test/orchestration/production-release-security.test.mjs
git add orchestration cloud/src scripts test/orchestration
git commit -m "test: harden production release recovery"
```

---

### Task 8: Documentation, dry-run verification, runtime activation, and real-release hold

**Files:**
- Modify: `docs/开发记录.md`
- Modify customer records per root AGENTS instructions
- Create customer audit evidence under `项目/365生活口语/资料/分析输出/`
- Modify local private runtime configuration only after all tests/reviews pass; never commit it

**Interfaces:**
- Produces a configured but externally disabled/hold-gated production release runtime.
- Real external release requires a separately named validation version and explicit user authorization after dry-run evidence review.

- [ ] **Step 1: Run complete verification**

```bash
pnpm test:orchestration
pnpm test
pnpm build
node --check scripts/orchestrator.mjs
node --check scripts/deploy-production-candidate.mjs
node --check scripts/release-all-ios-apps.mjs
git diff --check
```

Expected: all relevant suites/builds pass; unrelated pre-existing failures must be separately evidenced and cannot hide release failures.

- [ ] **Step 2: Run a no-side-effect production dry run**

Validate non-secret configuration, Candidate/Manifest creation against local fixtures, SSH/ASC credential presence without printing values, Web target reachability using read-only checks, App identity/read-only ASC queries, and command environment allowlists. Assert zero deploy/upload/review mutations.

- [ ] **Step 3: Update documentation and audit evidence**

Record architecture, configuration keys, recovery runbook, exact test counts, dry-run commands/results, known operational constraints, and the explicit hold on real production release. Update `沟通记录/当前沟通.md`, `沟通记录/交接摘要.md`, and the dated complete record without secrets.

- [ ] **Step 4: Validate structure and commit tracked docs**

```bash
python3 /Users/yuantao/Documents/customer-projects-management/00_总览/工具/project_mgmt.py validate-structure
git add docs/开发记录.md
git commit -m "docs: record production release automation"
```

- [ ] **Step 5: Activate runtime in hold mode and restart only the child**

Configure `releaseAdapterModule` and private command/config paths, with a release hold that blocks external POST/deploy effects. Restart only the supervised orchestrator child; prove supervisor stability, 47823/47824 HTTP 200, release readiness diagnostics, and no spontaneous release job.

- [ ] **Step 6: Independent final review**

Require zero Critical/Important findings across code, tests, config safety, and dry-run evidence. Do not proceed to real production release merely because review is green.

- [ ] **Step 7: Request separate real-release authorization**

Present the named validation version, exact Web/API targets, all iOS App identities/versions/build plan, irreversible Apple review/automatic-release effects, and rollback/compensation boundaries. Wait for explicit user approval before disabling the hold or creating any external release effect.

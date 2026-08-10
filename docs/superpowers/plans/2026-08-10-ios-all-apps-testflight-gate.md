# iOS All-App TestFlight Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require every enabled iOS App to build from the same Candidate, process successfully in App Store Connect, and join Internal Testing before an iOS task enters ready-for-test.

**Architecture:** A validated iOS App registry drives a TestFlight adapter and a persistent per-App gate coordinator. The existing staging coordinator deploys Web/API first, then invokes the iOS gate only for iOS-scoped tasks; the final acceptance transition occurs only after both gates succeed. App Store Connect readback, not command exit status, is authoritative.

**Tech Stack:** Node.js ESM, D1/SQLite migrations, Xcode/XcodeGen, `xcodebuild`, App Store Connect API/Transporter tooling already configured on the Mac, Node test runner.

## Global Constraints

- Current enabled Apps are `E365AU` (`online.365english.app`) and `E365CN` (`online.365english.china`).
- Every iOS task updates every enabled App even when a country target hides the changed feature.
- All Apps must be processed successfully and confirmed in their configured Internal Testing group before ClickUp can become `待测试`.
- All builds use the same Candidate SHA and marketing version; build numbers may differ per App and must strictly increase for that App.
- Any App failure fails the whole gate; no App Review or production release is submitted.
- Adding a future country App requires a registry entry, not orchestration code changes.
- New production behavior must be introduced through a failing test first.

---

## File Structure

- Create `orchestration/ios/app-registry.mjs`: validate and freeze runtime `iosApps` entries.
- Create `orchestration/ios/testflight-adapter.mjs`: command adapter for build/upload/readback operations.
- Create `orchestration/application/ios-staging-coordinator.mjs`: persistent all-App state machine, idempotency, evidence, and comments.
- Create `scripts/stage-all-ios-apps.mjs`: execute XcodeGen, tests, archive/export/upload and emit JSON evidence per App.
- Create migration `cloud/migrations/0010_ios_testflight_deployments.sql`: store per-task/per-Candidate/per-App attempts.
- Modify `orchestration/application/staging-coordinator.mjs`: invoke iOS gate before `acceptance_passed` when platform scope includes iOS.
- Modify `scripts/orchestrator.mjs` and `.data/orchestration.json`: load the registry and adapter.
- Test `test/orchestration/ios-app-registry.test.mjs`, `ios-staging-coordinator.test.mjs`, `testflight-adapter.test.mjs`, `staging-coordinator.test.mjs`, and `mvp-e2e.test.mjs`.

### Task 1: Validated, future-proof iOS App registry

**Files:**
- Create: `orchestration/ios/app-registry.mjs`
- Create: `test/orchestration/ios-app-registry.test.mjs`
- Modify: `.data/orchestration.json` (local runtime configuration, never commit secrets)
- Modify: `orchestration/clickup/config.example.json` only if a public runtime example is the established configuration location.

**Interfaces:**
- Produces: `loadIosApps(value): ReadonlyArray<{ id, name, enabled, scheme, bundleId, testFlightGroup, buildNumberSource }>`.
- Produces: `enabledIosApps(registry)` returning only frozen enabled entries.

- [ ] **Step 1: Write failing registry tests**

```js
test("registry returns every enabled country app", () => {
  const apps = loadIosApps([
    { id: "au", name: "海外版", enabled: true, scheme: "E365AU", bundleId: "online.365english.app", testFlightGroup: "Internal Testing", buildNumberSource: "app-store-connect" },
    { id: "cn", name: "中国版", enabled: true, scheme: "E365CN", bundleId: "online.365english.china", testFlightGroup: "Internal Testing", buildNumberSource: "app-store-connect" },
  ]);
  assert.deepEqual(enabledIosApps(apps).map(app => app.scheme), ["E365AU", "E365CN"]);
});
```

Add rejection tests for empty enabled set, duplicate id/scheme/bundle ID, missing group, and unsupported build number source.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/orchestration/ios-app-registry.test.mjs`

Expected: FAIL because the registry module does not exist.

- [ ] **Step 3: Implement strict validation and deep freezing**

Use `DomainError("INVALID_IOS_APP_CONFIG", ...)` with the offending field. Preserve input order for deterministic builds.

- [ ] **Step 4: Add the two current runtime entries**

Configure `E365AU`/`online.365english.app` and `E365CN`/`online.365english.china`, both enabled and assigned to their actual Internal Testing group names.

- [ ] **Step 5: Run and verify GREEN**

Run: `node --test test/orchestration/ios-app-registry.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add orchestration/ios/app-registry.mjs test/orchestration/ios-app-registry.test.mjs orchestration/clickup/config.example.json
git commit -m "feat: register every iOS app for staging"
```

### Task 2: Persistent per-App TestFlight evidence

**Files:**
- Create: `cloud/migrations/0010_ios_testflight_deployments.sql`
- Modify: `test/orchestration/migrations.test.mjs`
- Create: `test/orchestration/ios-testflight-persistence.test.mjs`

**Interfaces:**
- Table key: `(task_id, candidate_commit, app_id, attempt)`.
- Stored fields: scheme, bundle_id, marketing_version, build_number, upload_id, processing_status, test_group, membership_confirmed, stage, status, error, started_at, completed_at.

- [ ] **Step 1: Write failing migration tests**

Assert the migration creates the table, unique attempt identity, valid status checks, and indexes for latest task/Candidate/App lookup.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/orchestration/migrations.test.mjs test/orchestration/ios-testflight-persistence.test.mjs`

Expected: FAIL because migration `0010` and the table are absent.

- [ ] **Step 3: Add the migration**

Use status checks for `running|succeeded|failed` and stage checks for `prepare|archive|export|upload|processing|internal_testing|complete`.

- [ ] **Step 4: Add idempotent latest-success queries to the coordinator test fixture**

Verify a success is reusable only when task, Candidate, app id, marketing version, processing success, and membership confirmation all match.

- [ ] **Step 5: Run and verify GREEN**

Run: `node --test test/orchestration/migrations.test.mjs test/orchestration/ios-testflight-persistence.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cloud/migrations/0010_ios_testflight_deployments.sql test/orchestration/migrations.test.mjs test/orchestration/ios-testflight-persistence.test.mjs
git commit -m "feat: persist per-app TestFlight evidence"
```

### Task 3: TestFlight command adapter

**Files:**
- Create: `orchestration/ios/testflight-adapter.mjs`
- Create: `test/orchestration/testflight-adapter.test.mjs`

**Interfaces:**
- Produces: `createTestFlightAdapter({ runtime, projectRoot })`.
- Adapter method: `stage({ candidateCommit, targetVersion, app }): Promise<{ appId, scheme, bundleId, marketingVersion, buildNumber, uploadId }>`.
- Adapter method: `readback({ app, staged }): Promise<{ processed, processingStatus, testGroup, membershipConfirmed, checkedAt }>`.

- [ ] **Step 1: Write failing adapter tests**

Assert the adapter passes Candidate/app fields through environment variables, parses only the last JSON output line, rejects missing evidence, and rejects readback without exact bundle/version/build/group match.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/orchestration/testflight-adapter.test.mjs`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement command execution and evidence parsing**

Use `execFile` with configured timeout, project root cwd, inherited environment, and explicit `IOS_APP_ID`, `IOS_SCHEME`, `IOS_BUNDLE_ID`, `IOS_MARKETING_VERSION`, `IOS_TESTFLIGHT_GROUP`, `STAGING_CANDIDATE_COMMIT`, and `STAGING_REPO_PATH`.

- [ ] **Step 4: Implement fail-closed readback**

Invoke a separate configured readback command or App Store Connect helper. `processed === true` and `membershipConfirmed === true` are mandatory; upload command success alone is insufficient.

- [ ] **Step 5: Run and verify GREEN**

Run: `node --test test/orchestration/testflight-adapter.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add orchestration/ios/testflight-adapter.mjs test/orchestration/testflight-adapter.test.mjs
git commit -m "feat: add authoritative TestFlight adapter"
```

### Task 4: All-App iOS gate coordinator

**Files:**
- Create: `orchestration/application/ios-staging-coordinator.mjs`
- Create: `test/orchestration/ios-staging-coordinator.test.mjs`

**Interfaces:**
- Produces: `executeIosStagingGate({ db, client, taskId, candidateCommit, targetVersion, apps, adapter, now }): Promise<{ status, apps, error? }>`.
- Success requires one confirmed result for every enabled app snapshot entry.

- [ ] **Step 1: Write failing two-App aggregation tests**

Test AU success/CN failure, both uploaded but CN processing, both processed but CN group missing, and both fully confirmed. Assert only the last case returns completed.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/orchestration/ios-staging-coordinator.test.mjs`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement deterministic sequential execution**

Snapshot enabled apps, lookup reusable successes, otherwise create an attempt, call `stage`, persist upload evidence, call `readback`, and persist completion. Stop on first failure and return the failing App/stage.

- [ ] **Step 4: Add failing third-App extensibility test**

Append an enabled `E365NZ` fixture and assert the coordinator calls all three Apps without code changes or special branching.

- [ ] **Step 5: Add failing Candidate idempotency tests**

Assert same Candidate reuses fully confirmed App evidence, while a new Candidate invokes every App again even if version text is unchanged.

- [ ] **Step 6: Implement idempotency and structured comments**

Success evidence lists each name, scheme, bundle ID, version, build, upload id, and group. Failure evidence includes only the failed App/stage and a redacted error.

- [ ] **Step 7: Run and verify GREEN**

Run: `node --test test/orchestration/ios-staging-coordinator.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add orchestration/application/ios-staging-coordinator.mjs test/orchestration/ios-staging-coordinator.test.mjs
git commit -m "feat: gate iOS staging on every app"
```

### Task 5: Integrate the iOS gate with task staging

**Files:**
- Modify: `orchestration/application/staging-coordinator.mjs`
- Modify: `orchestration/ai/developer.mjs` or shared platform resolver export
- Modify: `scripts/orchestrator.mjs`
- Modify: `test/orchestration/staging-coordinator.test.mjs`
- Modify: `test/orchestration/mvp-e2e.test.mjs`

**Interfaces:**
- Consumes: normalized task platforms and `executeIosStagingGate`.
- Produces: `acceptance_passed` only after Web/API readback plus conditional all-App iOS success.

- [ ] **Step 1: Write failing integration tests**

For an iOS task, assert Web staging success alone does not dispatch `acceptance_passed`; all-App iOS success then dispatches exactly once. For a Web-only task, assert the iOS adapter is never called.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/orchestration/staging-coordinator.test.mjs test/orchestration/mvp-e2e.test.mjs`

Expected: FAIL because staging currently advances immediately after Web readback.

- [ ] **Step 3: Carry normalized platforms in the `stage_task` payload**

At enqueue time preserve the analyzed ClickUp platform scope. At execution time treat normalized case-insensitive `ios`/`iOS` as requiring the iOS gate.

- [ ] **Step 4: Invoke the iOS gate before the final transition**

After Candidate Web/API readback succeeds, call the iOS coordinator when required. On failure route through existing staging failure handling with stage `testflight:<appId>:<stage>`.

- [ ] **Step 5: Move the success comment after both gates**

Include Web/API release plus a TestFlight line for every enabled App. Do not emit the old success comment early.

- [ ] **Step 6: Run focused integration tests**

Run: `node --test test/orchestration/staging-coordinator.test.mjs test/orchestration/mvp-e2e.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add orchestration/application/staging-coordinator.mjs orchestration/ai/developer.mjs scripts/orchestrator.mjs test/orchestration/staging-coordinator.test.mjs test/orchestration/mvp-e2e.test.mjs
git commit -m "feat: require all TestFlight apps before testing"
```

### Task 6: Real build/upload script and preflight checks

**Files:**
- Create: `scripts/stage-all-ios-apps.mjs`
- Create: `test/orchestration/ios-staging-script.test.mjs`
- Modify: `.data/orchestration.json` (local command paths and actual Internal Testing group names)
- Modify: `docs/部署记录.md`

**Interfaces:**
- Script consumes the environment defined by Task 3 and prints one final JSON evidence line.
- Script exits non-zero on XcodeGen, tests, archive, export, upload, processing, or group-membership failure.

- [ ] **Step 1: Write failing script contract tests**

Extract pure command builders and assert they select the configured scheme, use Release/Staging API configuration, isolate DerivedData/archive/export paths per App, and never select the other App's bundle ID.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/orchestration/ios-staging-script.test.mjs`

Expected: FAIL because the script/command builders do not exist.

- [ ] **Step 3: Implement Candidate worktree and Xcode preflight**

Create a detached Candidate worktree, run XcodeGen, query the next App-specific build number, and run target-specific tests plus `xcodebuild archive` with explicit scheme/version/build settings.

- [ ] **Step 4: Implement export and artifact verification**

Export with App Store Connect options, inspect the archived Info.plist and IPA to prove exact bundle ID/version/build, confirm testing API configuration, and scan the Release binary/configuration for disabled debug IAP hooks.

- [ ] **Step 5: Implement upload and authoritative polling**

Use the existing private Apple credentials without printing them. Poll exact bundle/version/build until processing succeeds, add it to the configured group, then poll membership until confirmed or timeout.

- [ ] **Step 6: Run contract tests and a credential-free dry-run**

Run: `node --test test/orchestration/ios-staging-script.test.mjs`

Run: `IOS_STAGING_DRY_RUN=1 ... node scripts/stage-all-ios-apps.mjs`

Expected: tests PASS; dry-run prints commands/evidence without archive or upload and contains no secret values.

- [ ] **Step 7: Commit**

```bash
git add scripts/stage-all-ios-apps.mjs test/orchestration/ios-staging-script.test.mjs docs/部署记录.md
git commit -m "feat: build and stage every iOS app"
```

### Task 7: Full regression and controlled live verification

**Files:**
- Modify: `docs/开发记录.md`
- Modify: `docs/部署记录.md`

**Interfaces:**
- No new interface; validates the complete gate.

- [ ] **Step 1: Run the complete orchestration suite**

Run: `node --test test/orchestration/*.test.mjs`

Expected: all tests PASS.

- [ ] **Step 2: Validate the current two-App registry against Xcode**

Run XcodeGen and `xcodebuild -list`; assert `E365AU` and `E365CN` schemes exist and bundle IDs match the registry.

- [ ] **Step 3: Execute one controlled staging upload for both Apps**

Use a confirmed iOS Candidate and the real adapter. Do not submit App Review. Capture both version/build/upload ids.

- [ ] **Step 4: Verify App Store Connect readback**

Confirm both builds are processed and members of their configured Internal Testing groups. Verify the task remains outside `待测试` until the second confirmation, then advances exactly once.

- [ ] **Step 5: Record evidence and commit documentation**

```bash
git add docs/开发记录.md docs/部署记录.md
git commit -m "docs: record all-app TestFlight gate verification"
```

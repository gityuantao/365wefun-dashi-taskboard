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

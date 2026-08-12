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

`e53f3dc788e69c04692ea8f13af61c2c720dbccc` (this report update is amended into the same commit).

## Concerns

- Existing historical manifests without `candidateScope` remain supported and use their frozen task platform plan. New Candidate freezes persist Candidate scope and the canonical eligibility snapshot.
- The report itself is the only task artifact outside the source/test paths; `.data` remains excluded.

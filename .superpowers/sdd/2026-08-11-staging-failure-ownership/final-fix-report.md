# Final Fix Report

Date: 2026-08-11

Scope: the five blocking findings in `final-fix-brief.md` only. No live ClickUp, D1, deployment, TestFlight, App Review, or production mutation was performed. The untracked `.data/` directory was not read, modified, staged, or committed.

## Outcome

1. `acceptance_rejected -> ready_for_test` now requires an explicit confirmed ClickUp status delta and verified rejection ownership. Infrastructure-owned rejection dispatches `retry_staging`; unchanged snapshots do nothing; only proven `runner-acceptor` / `acceptance-*` rejection keeps the direct-to-test rule.
2. Merged remote PR integration returns its isolated refreshed Candidate source ref. Candidate persistence validates that ref, does not mutate a stale local version branch, and post-push verification uses the immutable remote Candidate/version refs.
3. Staging recovery resolves only the exact runner job named by the latest rejection's `staging-<jobId>` evidence. It requires the exact job to be a terminal failed `stage_task`, a `staging_infrastructure` failed result, a matching task/attempt payload, and an own array-valued `platforms` field. No historical fallback remains.
4. Staging requires `platforms` to be an own payload property and an array before attempt creation or external work. `[]` remains valid. Invalid values fail as infrastructure-owned rejection with a redacted result, ClickUp diagnostic, and `runner-staging` / `staging-<jobId>` event evidence; subsequent recovery without an attempt fails closed.
5. Production staging adapter import/factory work is lazy and runs inside `executeStagingGate` after attempt creation. Import or factory throws create one failed stage job/attempt with infrastructure ownership and rejection evidence; unchanged rejection state does not auto-retry or create development work after the retry window.

## RED -> GREEN evidence

- Finding 1: focused RED produced 2 expected failures (infrastructure was routed directly to test and an unchanged snapshot advanced); GREEN: 3/3 focused cases passed.
- Finding 2: real bare-remote/local regression RED failed with `version branch does not point to frozen Candidate`; GREEN: 1/1 passed while the local version branch remained at its stale commit and the Candidate ref was pushed at the advanced remote commit.
- Finding 3: seven damaged/absent exact-job chronology cases RED by incorrectly falling back to the older valid job; GREEN: exact success plus all seven fail-closed cases passed (9 test records including suite accounting).
- Finding 4: missing/string/null/object RED all completed staging and failed the boundary assertions; GREEN: all four fail closed before attempt/external work and the explicit-empty-array success case passed (6 test records including suite accounting).
- Finding 5: first RED showed the production lazy factory API missing; second RED showed both module/factory cases degrading to `staging adapter is not configured` because the factory was not invoked. GREEN: invalid module path and throwing factory both passed the full runner/attempt/poller boundary test (3 test records including suite accounting).

## Fresh verification

- Focused changed-path suite: `node --test test/orchestration/clickup-poller.test.mjs test/orchestration/git-merge.test.mjs test/orchestration/staging-coordinator.test.mjs test/orchestration/mvp-e2e.test.mjs test/orchestration/release-coordinator.test.mjs` -> 104 passed, 0 failed.
- Full orchestration suite: `pnpm test:orchestration` -> 484 passed, 0 failed.
- Static parsing: `node --check` on all six changed production modules -> exit 0.
- Diff hygiene: `git diff --check` -> exit 0.
- Customer-project structure: `python3 00_总览/工具/project_mgmt.py validate-structure` -> exit 0, no errors.

## Self-review

- No credentials or unredacted adapter error is persisted or posted; all coordinator failures pass through the existing redaction boundary.
- No product acceptance behavior, latest-12 comment/image behavior, Web/iOS gate, or infrastructure no-develop rule was weakened.
- No deferred Minor was addressed.
- No live or deployment write was performed.

Concerns: none.

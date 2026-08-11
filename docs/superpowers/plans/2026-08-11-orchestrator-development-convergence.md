# Orchestrator Development Convergence Implementation Plan

**Goal:** Make development rework converge by fixing role model selection, criteria propagation, full rejection feedback, and code-versus-environment acceptance responsibilities without implementing task `86d40bmd2` itself.

## Task 1: Auditable role model policy

- Modify `orchestration/runner/codex-runner.mjs` to require a role and resolve exact runtime model/effort.
- Modify `scripts/orchestrator.mjs` to pass `analysis`, `version_assignment`, `development`, or `acceptance` for every invocation.
- Add the non-secret role policy to the tracked runtime example and local private runtime.
- Persist safe role/model/effort metadata in runner results.
- Verify through a no-business-side-effect Codex adapter invocation boundary and static command inspection.

## Task 2: Exact analysis criteria and rejection findings

- Modify `cloud/src/clickup-poller.mjs` to load analysis by exact payload task identity for both development and acceptance.
- Fail closed when completed analysis lacks usable criteria.
- Load the latest exact-task rejected acceptance result and place its complete structured findings in the development payload.
- Modify `orchestration/ai/developer.mjs` and `orchestration/ai/prompts.mjs` to present criteria, findings, comments, feedback field, and images as distinct sources.
- Require a finding-by-finding implementation and verification summary in the development response.

## Task 3: Align development and code acceptance

- Replace the blanket no-test instruction with focused verification rules.
- Modify the acceptance prompt so deployed-environment/real-device evidence is deferred to staging/testing and cannot alone reject code acceptance.
- Preserve rejection for genuine implementation gaps, unconnected production code, invalid focused tests, or false success claims.
- Keep staging deployment and all-App TestFlight gates unchanged.

## Task 4: Direct-path verification and activation

- Run syntax checks and focused existing orchestration suites that exercise the changed main path only after the direct implementation is working.
- Restart only the supervised orchestrator child.
- Prove dashboard endpoints remain HTTP 200 and supervisor identity is unchanged.
- Inspect a controlled newly queued rework payload/result only after the user moves `86d40bmd2` back to development; verify eight criteria, full latest findings, and explicit role/model/effort.
- Do not alter the task's business code or force its final state.
- Update `docs/开发记录.md` and required customer communication records; run customer repository structure validation.

## Completion Gate

The fix is complete when the orchestrator's direct path is observable, the user confirms the next development run received the complete context, and no real production release side effect occurred. Only then resume the automated production release implementation plan from its existing Task 1 state.

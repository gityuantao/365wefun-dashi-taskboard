# Orchestrator Development Convergence Design

## Goal

Fix the orchestration contract that repeatedly sends incomplete development work into an impossible acceptance loop. The orchestrator must give each AI role an explicit, auditable model policy, deliver the complete analysis criteria and prior rejection findings to development, allow proportionate code verification, and reserve device/environment evidence for downstream testing rather than code acceptance.

This change fixes the orchestrator only. It must not implement the business requirements of ClickUp task `86d40bmd2` itself.

## Proven Operation Path

1. `cloud/src/clickup-poller.mjs` reads the ClickUp snapshot and creates `runner_jobs` payloads.
2. `scripts/orchestrator.mjs` claims those jobs and invokes `executeDevelopment` or `executeAcceptance`.
3. `orchestration/ai/developer.mjs` and `orchestration/ai/acceptance.mjs` build prompts from the job payload, ClickUp task, comments, and images.
4. `orchestration/runner/codex-runner.mjs` spawns `codex exec` in the task worktree.
5. The executor result is persisted to D1 and drives the task aggregate and ClickUp status.

Observed evidence for `86d40bmd2`:

- Analysis produced eight structured criteria, but all three development payloads contained `acceptanceCriteria: []`.
- The three development commits were `e8dc1808`, `1e6c5d2c`, and `3f8df25d`.
- Full rejection findings remained in D1 while the next development run primarily received abbreviated ClickUp comments.
- Development was instructed not to run tests/builds, while acceptance rejected it for missing tests and four-platform device evidence.
- `codex exec` received no `--model` or reasoning override, so the exact model was not auditable.

## Model Policy

The runtime configuration owns a required role map:

- analysis: `gpt-5.6-terra`, reasoning `high`
- version assignment: `gpt-5.6-terra`, reasoning `medium`
- development: `gpt-5.6-sol`, reasoning `xhigh`
- acceptance: `gpt-5.6-sol`, reasoning `high`

Every Codex invocation passes the selected model and reasoning effort explicitly. The safe role/model/effort metadata is returned by the adapter and persisted in the job result. Missing or unsupported role policy fails before invoking Codex; it must never silently fall back to a user-level default.

## Criteria and Rework Context

The poller loads the latest completed analysis by exact `payload.taskId`, parses `summary.acceptance_criteria`, and provides the same non-empty structured criteria to both development and acceptance jobs. If analysis has completed but the criteria cannot be parsed or are empty, development/acceptance fail closed with a diagnostic instead of silently accepting `[]`.

For a rework development job, the orchestrator additionally loads the latest completed rejected acceptance result for the exact task and passes the complete structured findings directly. These findings are separate from the newest ClickUp comment window. Comments, the acceptance-feedback custom field, and all selected recent comment images remain additive context.

The development prompt requires a finding-by-finding response: change location, corrective action, and verification evidence. A finding may be marked not applicable only with repository evidence.

## Verification Responsibilities

Development may run focused tests, focused type checks, and focused builds relevant to the changed code. It must not install dependencies without need, deploy production, or run unbounded repository-wide commands by default. If required dependencies or platform tooling are unavailable, it records the missing verification rather than claiming success.

Code acceptance checks implementation completeness, production call-path integration, regression tests appropriate to the change, and available focused verification. It may reject genuine code defects or missing code-level evidence.

Code acceptance must not reject solely because iOS/Web/Android/mini-program real-device or deployed-environment evidence is absent. Those checks belong to staging and human/system testing after code acceptance. The existing staging gate remains responsible for making the change testable before `ready_for_test`.

## Observable Result

After child restart, the dashboard remains healthy and new jobs persist explicit AI role/model/effort metadata. A controlled rework of `86d40bmd2` must show non-empty eight-item criteria and the full latest rejection findings in the development invocation evidence. This validation must not manually edit the product code or mark the task accepted.

## Safety Boundaries

- Do not expose prompt contents that contain secrets; task prompts and findings are non-secret but remain bounded.
- Continue attaching recent ClickUp comment images through the existing validated download path.
- Do not delete historical runner jobs or acceptance evidence.
- Do not trigger production deployment, App upload, App Review, or release.
- Do not automatically move `86d40bmd2`; the user controls when it is returned to development.

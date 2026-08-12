# PR Conflict Rework Design

## Goal

When a task PR cannot be integrated into its target version branch, the orchestrator must preserve actionable conflict evidence, return the task to development, update the existing PR, and retry acceptance/staging. An iOS task inferred during analysis must remain iOS through staging and therefore pass the all-enabled-App TestFlight gate.

## Proven operation path

1. `cloud/src/clickup-poller.mjs` queues a `stage_task` job after acceptance succeeds.
2. `scripts/orchestrator.mjs` claims the job and calls `executeStagingGate()`.
3. `orchestration/application/staging-coordinator.mjs` calls `fetchAndMergeTaskPullRequest()` in `orchestration/git/merge.mjs`.
4. A Git merge conflict currently returns only `merge.stderr`; Git writes the useful conflict output to stdout, so D1 and ClickUp receive an empty error.
5. The coordinator currently classifies every merge failure as staging infrastructure and produces `acceptance_rejected`, so no development job receives the conflict context.
6. The stage payload is reconstructed from task snapshots; an analysis-inferred iOS scope can be absent there and become `platforms: []`.

Observed examples:

- `86d40ezdx` / PR #915 conflicts in `VideoGuideStepView.swift` and `apps/ios/project.yml`.
- `86d40f2by` / PR #916 conflicts in `CourseView.swift`, `DayDetailView.swift`, and `apps/ios/project.yml`; its stage payload incorrectly contains `platforms: []`.

## Selected design

### Structured merge conflict evidence

The Git integration boundary returns a typed conflict result containing:

- classification `merge_conflict`;
- target version branch;
- existing PR number and URL;
- accepted task head SHA;
- sanitized combined Git stdout/stderr;
- a stable, sorted list of conflicted paths.

The useful Git output is retained with bounded redaction. Empty stderr can never erase stdout evidence.

### Product rework routing

A typed `merge_conflict` is a code-integration problem that the development agent can repair, not a deployment-infrastructure outage. The staging coordinator therefore:

- persists the failed attempt with `failure_owner=product_rework` and `failure_classification=merge_conflict`;
- emits an evidence-backed rejection event and ClickUp comment;
- transitions the task to `ready_for_development` through the normal state machine;
- never deploys, uploads, or creates a Candidate for the failed attempt.

The poller queues exactly one new `develop` job for the current rejection evidence. The development prompt receives the typed conflict evidence and is instructed to merge the latest target version branch into the task branch, resolve only the listed conflicts, run focused validation, push the same task branch, and update the existing PR. It must not create a replacement PR.

### Platform continuity

Analysis output remains the source of the normalized task platform scope. The completed analysis job stores normalized platforms alongside acceptance criteria. Subsequent development, acceptance, and staging job construction loads the latest completed analysis for the exact task and uses its platforms when the ClickUp snapshot field is empty. Explicit valid ClickUp platforms remain authoritative.

An inferred iOS result therefore yields `platforms: ["ios"]` in every later job. Empty or malformed evidence fails closed rather than silently becoming Web-only.

### Retry and completion

After the existing PR is updated:

1. development completes against the same task branch and PR;
2. acceptance runs with the conflict findings and current comments/images;
3. staging integrates the new PR head into the latest `version/v1.0.3` Candidate;
4. an iOS task runs the all-enabled-App TestFlight gate;
5. only authoritative membership confirmation for every enabled App permits `ready_for_test`.

## Observable behavior

For a merge conflict, the user sees a comment naming the PR, version branch, and conflicted files. The task automatically returns to 「待开发」 and later reuses the same PR. Dashboard/D1 retain the typed failure and no longer show `error: ""`.

For `86d40ezdx` and `86d40f2by`, successful completion requires the original PRs #915/#916 to receive new heads, become integrable, and resume the normal iOS staging path. No business-code conflict is resolved manually by the controller.

## Verification

- Reproduce a real temporary-repository conflict and assert stdout conflict paths survive into the typed result.
- Exercise staging conflict to verify product-rework ownership, exact evidence, no Candidate/deploy call, and automatic development job creation.
- Exercise analysis-inferred iOS with an empty ClickUp platform field and assert the stage payload contains `platforms: ["ios"]`.
- Restart only the supervised orchestrator child after committing.
- Restore the two live tasks through the normal state machine and verify original PR reuse, new PR heads, successful Candidate integration, and all-App TestFlight evidence before `ready_for_test`.

## Safety boundaries

- Do not manually edit either task's business code.
- Do not create replacement PRs.
- Do not delete historical attempts or acceptance evidence.
- Do not bypass acceptance, Candidate verification, or TestFlight gates.
- Do not expose credentials or raw unbounded command output.

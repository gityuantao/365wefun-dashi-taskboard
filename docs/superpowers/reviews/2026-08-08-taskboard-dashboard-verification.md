# Taskboard dashboard verification — 2026-08-08

Status: **BLOCKED / staged visual evidence only**. The dashboard evidence below is usable, but Task 8 cannot be accepted because the repository-wide check exits non-zero with 18 failures. No business-code fix was made in this verification task, and automatic orchestration remained disabled.

## Environment

- Worktree: `codex-taskboard-stability`
- Runtime: Node.js `v24.14.0`; pnpm `11.16.0`
- Requested port `47824` was already occupied by the existing orchestrator (PID 42609), so the isolated app was started on `127.0.0.1:47825`.
- Isolated data directory: `/tmp/taskboard-verification-sIrEvm`; repository `.data` was not used or changed.
- Read-only control check on `47824`: `enabled=false`, `updatedAt=2026-08-08T15:57:32.877Z`.
- Browser evidence was captured with automatic orchestration disabled. The temporary app process was stopped after verification.

## Full check output

Command: `pnpm check`

- Result: **FAIL** (exit code 1; approximately 81.7 seconds).
- TypeScript check: pass.
- Production build: pass (111 ms).
- Build warning: generated chunks larger than 500 kB after minification.
- Injector refresh: skipped because no debuggable Codex window was running.
- Tests: 684 total; 666 passed; 18 failed; 0 skipped; duration approximately 103.1 seconds.

The 18 failing tests were:

1. `Codex turns use stdin, explicit resume ids, server-owned cwd and sanitized visible events`
2. `loopback AI API freezes server-owned origin and rejects injected execution fields`
3. `test/ai-chat-state.test.mjs` — `web/src/aiChatState.ts` does not export `insertSkillMention`
4. `test/ai-chat-ui.test.mjs` — same missing export
5. `comments stage, upload, render and delete their own attachments`
6. `configured server proxies business APIs without touching local rows and advertises polling`
7. `comment composer aligns with the full comment floor width`
8. `complete App automation payloads cross the injected forwarder into the current parser`
9. `editing and composing comments do not add focus chrome`
10. `the automation menu reuses the Linear switch and keeps form focus chrome suppressed`
11. `unavailable automation state has one notice, clears stale errors, and cannot change`
12. `opening settings and changing projects reconcile with the host list`
13. `new issues stage attachments in the composer and upload them after creation`
14. `workflow capabilities come from the live Codex skill and MCP catalogs`
15. `task thread migration excludes comment-only aggregate entries`
16. `the automation host request accepts only whitelisted project automation options`
17. `workflow editing is a constrained vertical execution sequence instead of a free canvas`
18. `deleting a condition removes its subtree, while conditions move as one subtree and cannot duplicate`

All observed Task 4–7 dashboard checks were green in the full run. However, there is no accepted repository-wide pre-existing baseline that permits these 18 failures, so they block Task 8 rather than being reclassified as success.

## Focused orchestration output

Command: `pnpm test:orchestration`

- Result: **PASS** (exit code 0).
- Tests: 292 total; 292 passed; 0 failed; duration 21.66 seconds.
- This focused pass narrows the full-check failures away from orchestration domain tests, but it does not override the failing repository-wide gate.

## Responsive screenshots

- `assets/dashboard-wide-light.png` — wide light dashboard, 1440 × 837 captured image.
- `assets/dashboard-narrow-light.png` — narrow light dashboard, 744 × 1224.
- `assets/dashboard-wide-dark.png` — wide dark dashboard, 1440 × 1000.
- `assets/dashboard-task-dialog.png` — task-detail dialog, 1440 × 1000.

Measured layout results:

- Wide light: page `clientWidth=1440`, `scrollWidth=1440`; dashboard `clientWidth=1320`, `scrollWidth=1320`; no horizontal overflow.
- Narrow light: page `clientWidth=744`, `scrollWidth=744`; dashboard `clientWidth=733`, `scrollWidth=733`; workspace collapsed to one column. Vertical scroll (`1453 > 1178`) is expected and content remained reachable.
- Wide dark: same horizontal measurements as wide light; dark tokens remained coherent and no content was clipped.
- Task dialog: left 345, right 1095, top 120, bottom 880; dialog width 750 and height 760. The dialog body intentionally scrolls vertically (`891 > 636`) and has no horizontal overflow (`737 = 737`).

## Dialog keyboard matrix

| Dialog | Initial focus | Backward/forward wrap | Escape | Focus return | Result |
|---|---|---|---|---|---|
| Task detail | Close button | Shift+Tab reaches the final `查看 PR` link; Tab wraps to Close | Closes | Returns to the exact activity trigger | PASS |
| Version detail | Close button | Shift+Tab reaches the final ClickUp task link; Tab wraps to Close | Closes | Returns to the exact `v1.0.3` trigger | PASS |
| Orchestration control | Close button | Shift+Tab reaches the disabled-state switch; Tab wraps to Close | Closes | Returns to the exact `编排已暂停` trigger | PASS |
| Release detail | Not reachable in real data | Not executed | Not executed | Not executed | **BLOCKED / unavailable** |

The live dashboard returned zero `releasableVersions`, so no release-detail trigger existed. Per the verification scope, this is recorded as unavailable rather than simulated or reported as a pass. Pending-state dismissal for the control dialog is covered by the existing automated dashboard test; the live toggle was deliberately not invoked because doing so would change orchestration state.

## Acceptance-criteria mapping

| Criterion | Evidence | Status |
|---|---|---|
| Repository-wide `pnpm check` exits 0 | 18 failures, exit 1 | **BLOCKED** |
| Focused orchestration remains sound | 292/292 pass | PASS |
| Wide/narrow responsive layout has no horizontal clipping | Runtime width measurements plus screenshots | PASS |
| Light and dark visual treatments remain coherent | Wide light/dark screenshots | PASS |
| Task/version/control dialogs trap focus, close on Escape, and restore focus | Manual keyboard matrix | PASS |
| Release dialog keyboard behavior verified | No live release trigger | **BLOCKED / unavailable** |
| Automatic orchestration remains disabled | Read-only control API returned `enabled=false` | PASS |

Overall Task 8 acceptance: **BLOCKED**.

## Known residual risks

- The 18 repository-wide failures can hide regressions outside the dashboard slice. Next action: fix or formally baseline each failure in a separate implementation task, then rerun `pnpm check` to zero failures.
- Release-detail keyboard behavior has no live evidence because there was no releasable version. Next action: verify with an approved deterministic fixture or when a real releasable version exists; do not infer success from the version-detail dialog.
- The production build emits a >500 kB chunk warning. Impact is performance rather than this task's functional acceptance; consider route/component splitting separately.
- The wide-light capture was emitted at 1440 × 837 despite a requested 1440 × 1000 viewport; width and overflow measurements are valid, but a strict pixel-height requirement would need a recapture in a browser surface that preserves the full requested viewport.

## Rollback commits

Dashboard implementation commits in this verification chain:

- `72a5d85` — ignore stale dashboard responses
- `65b6dd7` — unify dashboard dialogs
- `2e1a8dd` — contain focus in busy dashboard dialog
- `411933e` — align dashboard information architecture
- `66cb2d0` — align dashboard with Codex Desktop

Rollback should be done with targeted `git revert` in reverse order, not by resetting the worktree. The Task 8 evidence commit is listed in the task handoff after creation.

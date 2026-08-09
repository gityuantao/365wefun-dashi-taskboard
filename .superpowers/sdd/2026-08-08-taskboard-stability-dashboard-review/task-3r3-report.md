# Task 3R3 report — outbox preconditions and remote confirmation

## Status

Implemented the three required outbox contracts without real ClickUp writes. The existing manual `waiting_info` snapshot and remote guards remain authoritative.

## RED evidence

Command:

```bash
node --test test/orchestration/clickup-outbox.test.mjs test/orchestration/clickup-client.test.mjs
```

Observed before production changes: 23 tests, 19 passed, 4 failed.

- Mutation transport failure was replayed four times instead of once (`4 !== 1`).
- A successful status response was marked confirmed without target readback (`Missing expected rejection`).
- An unknown write outcome propagated immediately instead of reconciling remote state.
- A shaped custom-field `expectedBefore` could not be persisted and had no remote precondition path.

The focused fail-closed test also failed before production changes because a status mutation wrote and confirmed when `getTask` was unavailable.

## GREEN evidence

Command:

```bash
node --test test/orchestration/clickup-outbox.test.mjs test/orchestration/clickup-client.test.mjs
```

Observed after implementation: 24 tests, 24 passed, 0 failed, exit code 0.

Covered behavior:

- normalized status/custom-field precondition conflicts expire without a write or confirmation;
- missing authoritative remote state fails closed and leaves the mutation pending;
- successful writes remain pending unless normalized readback equals the target;
- transport failures are read back once and are confirmed only if the remote target is present;
- non-GET ClickUp requests are not blindly replayed by the client;
- status and custom-field write payload behavior remains covered;
- local and remote manual `waiting_info` guards remain covered.

## Changed files

- `orchestration/clickup/outbox.mjs`
- `orchestration/clickup/client.mjs`
- `test/orchestration/clickup-outbox.test.mjs`
- `test/orchestration/clickup-client.test.mjs`
- `.superpowers/sdd/2026-08-08-taskboard-stability-dashboard-review/task-3r3-report.md`

## Commit

- Implementation: `a745fe4` (`fix: confirm ClickUp outbox mutations remotely`)

## Concerns

- No real ClickUp request was sent; all write/readback paths were exercised with local fakes and the D1 test harness as required.
- Mutations whose write response succeeds but whose remote value still equals `expected_before` remain pending and surface `REMOTE_CONFIRMATION_FAILED`; a later flush must re-establish the precondition before attempting again.
- Existing untracked `.data` in the worktree was not modified or committed.

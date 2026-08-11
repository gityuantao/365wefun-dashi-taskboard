# Task 6 Report — Authorized confirmation API and release progress dashboard

## Real operation path

The Web version detail opens the production confirmation portal and calls `publishOrchestrationVersion` with the exact version and a stable request ID. Port 47823 owns the built-in personal local-user identity, forwards that identity and role through the private Bearer-protected 47824 hop, and the dashboard server revalidates dynamic production readiness, version/task/blocker/platform readiness, exact confirmation, and idempotency before writing one fenced `releasing` outbox mutation. The Cloud diagnostic route is read-only for production release and fails POST closed to the local runtime.

## Implemented behavior

- Exact `{ confirmationVersion, requestId }` request contract and stable request replay.
- `release_manager|admin` authorization at the authenticated Cloud boundary and built-in local-owner boundary.
- Dynamic runtime, version state, task readiness, open blocker, supported platform, iOS registry, and status-map checks before enqueue.
- Outbox `expectedBefore` binds the observed canonical version status; actor identity is audited.
- Pending requests are reusable only before expiry; confirmed requests remain idempotently readable.
- Version detail returns safe Manifest fields, readiness gaps, the complete planned target set, latest safe stage/readback state, and sanitized errors without private references or raw evidence.
- Confirmation portal shows Candidate, task count, Web/API/App Store targets and safe App identities; exact version input is mandatory.
- Per-target progress distinguishes pending/running/succeeded/failed and stage update versus authoritative readback.
- Failed release exposes the same explicit confirmation path as “重试失败目标”; no force-success or skip control exists.
- Portal provides Escape close, Tab containment, focus-in containment, and post-unmount focus restoration while preserving the existing Codex Desktop token-driven responsive visual language.

## TDD and review

Initial REDs proved the missing confirmation body/types/dialog, role checks, idempotency, platform/blocker gates, safe detail and target progress. Four independent review rounds then drove concrete RED/GREEN fixes for Cloud fail-closed behavior, caller identity, outbox fencing/expiry, Manifest redaction, frozen scope, complete target progress, first-release iOS version preview, and modal accessibility.

No production deployment, App Store Connect mutation, ClickUp mutation, live D1 operation, secret read, or `.data` access occurred. Tests use local HTTP servers and temporary/in-memory databases.

## Verification

- `pnpm test:dashboard`: 51/51 PASS.
- `pnpm typecheck`: PASS.
- `pnpm build:web`: PASS (only the existing chunk-size warning).
- Real 47823 → 47824 → outbox proxy suite: PASS.
- Production runtime and release coordinator related regressions: PASS.
- `git diff --check`: PASS.

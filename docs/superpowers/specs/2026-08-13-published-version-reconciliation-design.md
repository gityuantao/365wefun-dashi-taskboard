# Published Version Reconciliation Design

## Problem

ClickUp already marks v1.0.3 as published, but the poller only stores the external version snapshot. The dashboard prefers the stale internal aggregate state, so it displays the version as active and repeatedly evaluates production readiness for historical tasks.

## Design

Treat ClickUp's `published` version status as authoritative historical evidence. During polling, reconcile the internal version aggregate through the existing legal state transitions until it reaches `published`. This reconciliation records internal events only: it must not invoke a production release adapter, enqueue a release, or write status back to ClickUp.

For a published or canceled version detail, return a terminal, read-only release-readiness result with no pre-release configuration gaps. For non-terminal versions, preserve the current readiness calculation but deduplicate identical gap strings while retaining first-seen order.

## Verification

- A published ClickUp snapshot moves an active internal aggregate to `published`, even when the snapshot itself has not changed since the prior poll.
- A published version detail contains no production-target configuration gaps.
- Multiple tasks missing the same platform target produce one gap.
- Existing active-version readiness behavior remains unchanged.

## Safety

The reconciliation never runs release execution code and never performs ClickUp mutations. It only appends local orchestration events representing an already-observed external terminal state.

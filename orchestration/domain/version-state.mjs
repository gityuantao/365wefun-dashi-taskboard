import { DomainError } from "./errors.mjs";

export const VERSION_STATES = [
  "planning",
  "active",
  "ready_for_release",
  "releasing",
  "release_failed",
  "published",
  "canceled",
];

const TERMINAL_STATES = new Set(["published", "canceled"]);

const VERSION_TRANSITIONS = new Map([
  ["planning:active", { to: "active", eventType: "version.activated" }],
  ["active:ready_for_release", { to: "ready_for_release", eventType: "version.release_prepared" }],
  ["ready_for_release:releasing", { to: "releasing", eventType: "version.release_started" }],
  ["releasing:published", { to: "published", eventType: "version.published" }],
  [
    "releasing:release_failed",
    { to: "release_failed", eventType: "version.release_failed", evidenceRequired: true },
  ],
  [
    "release_failed:releasing",
    { to: "releasing", eventType: "version.release_retried", evidenceRequired: true },
  ],
  [
    "release_failed:active",
    { to: "active", eventType: "version.returned_to_active", evidenceRequired: true },
  ],
]);

function invalidTransition(from, to) {
  return new DomainError(
    "INVALID_TRANSITION",
    `Version transition from "${from}" to "${to}" is not allowed`,
    { from, to },
  );
}

function assertKnownStates(from, to) {
  for (const [state, field] of [[from, "from"], [to, "to"]]) {
    if (!VERSION_STATES.includes(state)) {
      throw new DomainError(
        "UNKNOWN_STATE",
        `Unknown version state "${state}" in "${field}"`,
        { field, state },
      );
    }
  }
}

function requireEvidence(transition, evidenceId) {
  if (transition === "canceled" || transition.evidenceRequired) {
    const target = transition === "canceled" ? "canceled" : transition.to;
    if (typeof evidenceId !== "string" || evidenceId.trim() === "") {
      throw new DomainError(
        "EVIDENCE_REQUIRED",
        `Version transition to "${target}" requires a non-empty evidenceId`,
        { to: target },
      );
    }
  }
}

export function decideVersionTransition({ from, to, evidenceId }) {
  assertKnownStates(from, to);
  if (from === to) {
    throw invalidTransition(from, to);
  }
  if (to === "canceled") {
    if (TERMINAL_STATES.has(from)) {
      throw invalidTransition(from, to);
    }
    requireEvidence("canceled", evidenceId);
    return { from, to, eventType: "version.canceled" };
  }
  const transition = VERSION_TRANSITIONS.get(`${from}:${to}`);
  if (!transition) {
    throw invalidTransition(from, to);
  }
  requireEvidence(transition, evidenceId);
  return { from, to, eventType: transition.eventType };
}

import { DomainError } from "./errors.mjs";

export const TASK_STATES = [
  "inbox",
  "analyzing",
  "ready_for_development",
  "developing",
  "ready_for_test",
  "testing",
  "ready_for_acceptance",
  "accepting",
  "ready_for_release",
  "published",
  "canceled",
];

const TERMINAL_STATES = new Set(["published", "canceled"]);

const TASK_TRANSITIONS = new Map([
  ["inbox:analyzing", { to: "analyzing", eventType: "task.analysis_started" }],
  ["analyzing:ready_for_development", { to: "ready_for_development", eventType: "task.analysis_completed" }],
  ["ready_for_development:developing", { to: "developing", eventType: "task.development_started" }],
  ["developing:ready_for_test", { to: "ready_for_test", eventType: "task.development_completed" }],
  [
    "developing:ready_for_development",
    { to: "ready_for_development", eventType: "task.development_failed", evidenceRequired: true },
  ],
  ["ready_for_test:testing", { to: "testing", eventType: "task.test_started" }],
  ["testing:ready_for_acceptance", { to: "ready_for_acceptance", eventType: "task.test_passed" }],
  [
    "testing:ready_for_development",
    { to: "ready_for_development", eventType: "task.test_failed", evidenceRequired: true },
  ],
  ["ready_for_acceptance:accepting", { to: "accepting", eventType: "task.acceptance_started" }],
  ["accepting:ready_for_release", { to: "ready_for_release", eventType: "task.acceptance_passed" }],
  [
    "accepting:ready_for_development",
    { to: "ready_for_development", eventType: "task.acceptance_failed", evidenceRequired: true },
  ],
  ["ready_for_release:published", { to: "published", eventType: "task.published" }],
]);

function invalidTransition(from, to) {
  return new DomainError(
    "INVALID_TRANSITION",
    `Task transition from "${from}" to "${to}" is not allowed`,
    { from, to },
  );
}

function assertKnownStates(from, to) {
  for (const [state, field] of [[from, "from"], [to, "to"]]) {
    if (!TASK_STATES.includes(state)) {
      throw new DomainError(
        "UNKNOWN_STATE",
        `Unknown task state "${state}" in "${field}"`,
        { field, state },
      );
    }
  }
}

function requireEvidence(transition, evidenceId) {
  if (transition.evidenceRequired || transition === "canceled") {
    if (typeof evidenceId !== "string" || evidenceId.trim() === "") {
      throw new DomainError(
        "EVIDENCE_REQUIRED",
        `Task transition to "${transition === "canceled" ? "canceled" : transition.to}" requires a non-empty evidenceId`,
        { from: null, to: transition === "canceled" ? "canceled" : transition.to },
      );
    }
  }
}

export function decideTaskTransition({ from, to, evidenceId }) {
  assertKnownStates(from, to);
  if (from === to) {
    throw invalidTransition(from, to);
  }
  if (to === "canceled") {
    if (TERMINAL_STATES.has(from)) {
      throw invalidTransition(from, to);
    }
    requireEvidence("canceled", evidenceId);
    return { from, to, eventType: "task.canceled" };
  }
  const transition = TASK_TRANSITIONS.get(`${from}:${to}`);
  if (!transition) {
    throw invalidTransition(from, to);
  }
  requireEvidence(transition, evidenceId);
  return { from, to, eventType: transition.eventType };
}

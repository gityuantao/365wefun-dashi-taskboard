import assert from "node:assert/strict";
import test from "node:test";
import {
  TASK_STATES,
  decideTaskTransition,
} from "../../orchestration/domain/task-state.mjs";
import {
  VERSION_STATES,
  decideVersionTransition,
} from "../../orchestration/domain/version-state.mjs";

test("task states and version states export stable lists", () => {
  assert.deepEqual(TASK_STATES, [
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
  ]);
  assert.deepEqual(VERSION_STATES, [
    "planning",
    "active",
    "ready_for_release",
    "releasing",
    "release_failed",
    "published",
    "canceled",
  ]);
});

test("task happy path is exact", () => {
  const path = [
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
  ];
  for (let index = 0; index < path.length - 1; index += 1) {
    assert.equal(
      decideTaskTransition({ from: path[index], to: path[index + 1] }).to,
      path[index + 1],
    );
  }
});

test("test failure returns to ready for development", () => {
  assert.equal(
    decideTaskTransition({
      from: "testing",
      to: "ready_for_development",
      evidenceId: "ev-1",
    }).eventType,
    "task.test_failed",
  );
});

test("acceptance failure returns to ready for development", () => {
  assert.equal(
    decideTaskTransition({
      from: "accepting",
      to: "ready_for_development",
      evidenceId: "ev-2",
    }).eventType,
    "task.acceptance_failed",
  );
});

test("failure returns require an evidence id", () => {
  assert.throws(
    () => decideTaskTransition({ from: "testing", to: "ready_for_development" }),
    /EVIDENCE_REQUIRED/,
  );
  assert.throws(
    () => decideTaskTransition({ from: "accepting", to: "ready_for_development" }),
    /EVIDENCE_REQUIRED/,
  );
});

test("task rejects unknown jumps and terminal-state exits", () => {
  assert.throws(
    () => decideTaskTransition({ from: "ready_for_development", to: "testing" }),
    /INVALID_TRANSITION/,
  );
  for (const terminal of ["published", "canceled"]) {
    assert.throws(
      () => decideTaskTransition({ from: terminal, to: "inbox" }),
      /INVALID_TRANSITION/,
    );
  }
});

test("any un-terminated task can be canceled", () => {
  for (const from of TASK_STATES.filter((state) => !["published", "canceled"].includes(state))) {
    assert.equal(
      decideTaskTransition({ from, to: "canceled", evidenceId: "reason-1" }).eventType,
      "task.canceled",
    );
  }
});

test("version happy path and failure retry loop are exact", () => {
  const path = ["planning", "active", "ready_for_release", "releasing", "published"];
  for (let index = 0; index < path.length - 1; index += 1) {
    assert.equal(
      decideVersionTransition({ from: path[index], to: path[index + 1] }).to,
      path[index + 1],
    );
  }
  assert.equal(
    decideVersionTransition({ from: "releasing", to: "release_failed", evidenceId: "fail-1" })
      .eventType,
    "version.release_failed",
  );
  assert.equal(
    decideVersionTransition({
      from: "release_failed",
      to: "releasing",
      evidenceId: "retry-1",
    }).eventType,
    "version.release_retried",
  );
  assert.equal(
    decideVersionTransition({
      from: "release_failed",
      to: "active",
      evidenceId: "change-1",
    }).eventType,
    "version.returned_to_active",
  );
});

test("version cannot skip release preparation", () => {
  assert.throws(
    () => decideVersionTransition({ from: "active", to: "releasing" }),
    /INVALID_TRANSITION/,
  );
});

test("version failure returns require an evidence id and lock terminal states", () => {
  assert.throws(
    () => decideVersionTransition({ from: "release_failed", to: "releasing" }),
    /EVIDENCE_REQUIRED/,
  );
  for (const terminal of ["published", "canceled"]) {
    assert.throws(
      () => decideVersionTransition({ from: terminal, to: "planning" }),
      /INVALID_TRANSITION/,
    );
  }
});

test("any un-terminated version can be canceled", () => {
  for (const from of VERSION_STATES.filter((state) => !["published", "canceled"].includes(state))) {
    assert.equal(
      decideVersionTransition({ from, to: "canceled", evidenceId: "reason-2" }).eventType,
      "version.canceled",
    );
  }
});

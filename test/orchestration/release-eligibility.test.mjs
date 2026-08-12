import assert from "node:assert/strict";
import test from "node:test";

import { buildReleaseEligibility } from "../../orchestration/release/release-eligibility.mjs";

const candidateScope = (platforms = ["web"], unsupported = []) => ({
  baseCommit: "a".repeat(40),
  candidateCommit: "b".repeat(40),
  mappingVersion: 1,
  changedPaths: [],
  platforms,
  unsupported,
});

test("38 ready tasks remain closed when one task lacks required evidence", () => {
  const tasks = Array.from({ length: 38 }, (_, index) => ({
    id: `task-${index + 1}`,
    status: "ready_for_release",
  }));
  const eligibility = buildReleaseEligibility({
    version: { id: "v1", status: "active" },
    tasks,
    blockers: [],
    platformEvidence: tasks.slice(0, -1).map((task) => ({
      taskId: task.id, platforms: ["web"], source: "accepted_pr", commitSha: "c".repeat(40),
    })),
    candidateScope: candidateScope(),
    configuredTargets: ["web"],
    runtimeReadiness: { ready: true },
  });

  assert.equal(eligibility.ready, false);
  assert.ok(eligibility.gaps.some((gap) => gap.includes("task-38")));
});

test("Candidate scope supplements a missing task platform only as an auditable version target", () => {
  const scope = candidateScope(["mini_program"]);
  const eligibility = buildReleaseEligibility({
    version: { id: "v1", status: "active" },
    tasks: [{ id: "task-mp", status: "ready_for_release" }],
    blockers: [],
    platformEvidence: [{ taskId: "task-mp", platforms: [], source: "missing", commitSha: null }],
    candidateScope: scope,
    configuredTargets: ["mini_program"],
    runtimeReadiness: { ready: true },
  });

  assert.equal(eligibility.ready, true);
  assert.deepEqual(eligibility.taskPlatforms, [{
    taskId: "task-mp", platforms: ["mini_program"], source: "candidate_scope", evidenceId: null,
    commitSha: null, acceptedCommitSha: null,
  }]);
  assert.strictEqual(eligibility.candidateScope, scope);
  assert.deepEqual(eligibility.plannedTargets, ["mini_program"]);
});

test("claimed independent-client scope without Candidate evidence is drift", () => {
  const eligibility = buildReleaseEligibility({
    version: { id: "v1", status: "active" },
    tasks: [{ id: "task-ios", status: "ready_for_release" }],
    blockers: [],
    platformEvidence: [{ taskId: "task-ios", platforms: ["ios"], source: "accepted_pr", commitSha: "c".repeat(40) }],
    candidateScope: candidateScope(["web"]),
    configuredTargets: ["web", "ios"],
    runtimeReadiness: { ready: true },
  });

  assert.equal(eligibility.ready, false);
  assert.ok(eligibility.gaps.some((gap) => gap.includes("ios") && gap.includes("Candidate")));
});

test("projects Android TWA to the web target and blocks unsupported native Android", () => {
  const twa = buildReleaseEligibility({
    version: { id: "v1", status: "active" }, tasks: [{ id: "task-web", status: "ready_for_release" }], blockers: [],
    platformEvidence: [{ taskId: "task-web", platforms: ["android_twa"], source: "accepted_pr", commitSha: "c".repeat(40) }],
    candidateScope: candidateScope(["android_twa"]), configuredTargets: ["web"], runtimeReadiness: { ready: true },
  });
  assert.equal(twa.ready, true);
  assert.deepEqual(twa.plannedTargets, ["web"]);

  const native = buildReleaseEligibility({
    version: { id: "v1", status: "active" }, tasks: [{ id: "task-native", status: "ready_for_release" }], blockers: [],
    platformEvidence: [{ taskId: "task-native", platforms: [], source: "missing", commitSha: null }],
    candidateScope: candidateScope([], ["android_native"]), configuredTargets: ["web"], runtimeReadiness: { ready: true },
  });
  assert.equal(native.ready, false);
  assert.ok(native.gaps.some((gap) => gap.includes("android_native")));
});

test("missing 86d40ejq2 evidence remains closed", () => {
  const eligibility = buildReleaseEligibility({
    version: { id: "v1", status: "active" }, tasks: [{ id: "86d40ejq2", status: "ready_for_release" }], blockers: [],
    platformEvidence: [], candidateScope: candidateScope(), configuredTargets: ["web"], runtimeReadiness: { ready: true },
  });
  assert.equal(eligibility.ready, false);
  assert.ok(eligibility.gaps.some((gap) => gap.includes("86d40ejq2")));
});

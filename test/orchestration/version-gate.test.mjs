import assert from "node:assert/strict";
import test from "node:test";
import {
  checkTaskVersionGate,
  resolveCurrentDevVersionName,
} from "../../orchestration/application/version-gate.mjs";

test("resolveCurrentDevVersionName picks the smallest unreleased version", () => {
  const versions = [
    { id: "v2", name: "1.0.2", status: { status: "进行中" } },
    { id: "v0", name: "1.0.0", status: { status: "已发布" } },
    { id: "v1", name: "1.0.1", status: { status: "进行中" } },
  ];
  assert.equal(resolveCurrentDevVersionName(versions), "1.0.1");
});

test("resolveCurrentDevVersionName ignores released and canceled versions", () => {
  const versions = [
    { id: "v0", name: "1.0.0", status: { status: "已发布" } },
    { id: "v1", name: "1.0.1", status: { status: "已取消" } },
  ];
  assert.equal(resolveCurrentDevVersionName(versions), null);
});

test("resolveCurrentDevVersionName returns null when versions list is empty", () => {
  assert.equal(resolveCurrentDevVersionName([]), null);
});

test("task without target version is allowed (analysis will assign one)", () => {
  const gate = checkTaskVersionGate({ targetVersion: null, currentDevVersion: "1.0.1" });
  assert.equal(gate.blocked, false);
});

test("task of the current dev version is allowed", () => {
  const gate = checkTaskVersionGate({ targetVersion: "1.0.1", currentDevVersion: "1.0.1" });
  assert.equal(gate.blocked, false);
});

test("task of a non-current version is blocked", () => {
  const gate = checkTaskVersionGate({ targetVersion: "1.0.2", currentDevVersion: "1.0.1" });
  assert.equal(gate.blocked, true);
  assert.equal(gate.waitingFor, "1.0.2");
});

test("versioned task is blocked when there is no unreleased version", () => {
  const gate = checkTaskVersionGate({ targetVersion: "1.0.1", currentDevVersion: null });
  assert.equal(gate.blocked, true);
});

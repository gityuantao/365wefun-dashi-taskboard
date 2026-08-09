import assert from "node:assert/strict";
import test from "node:test";
import { loadClickUpConfig } from "../../orchestration/clickup/config-registry.mjs";
import { assignTaskVersion } from "../../orchestration/application/version-assignment.mjs";
import {
  bumpVersion,
  maxVersionName,
  parseVersion,
} from "../../orchestration/release/version-utils.mjs";

const CONFIG = loadClickUpConfig({
  teamId: "90161712199",
  spaceId: "90167718544",
  lists: {
    task: { id: "1", name: "任务" },
    version: { id: "2", name: "版本" },
    taskSandbox: { id: "901616314492", name: "任务-Sandbox" },
    versionSandbox: { id: "901616314494", name: "版本-Sandbox" },
  },
  taskStatusMap: { 收件箱: "inbox" },
  versionStatusMap: { 进行中: "active", 已发布: "published" },
  fields: {
    task: { 目标版本: { id: "field-version", type: "list_relationship" } },
    version: {},
    taskSandbox: { 目标版本: { id: "field-version", type: "list_relationship" } },
    versionSandbox: {},
  },
});

function task(id, version = null) {
  return {
    id,
    name: "任务",
    description: "需求描述",
    custom_fields: version ? [{ id: "field-version", name: "目标版本", value: version }] : [],
  };
}

function version(name, status = "进行中", description = "") {
  return { id: `v-${name}`, name, status: { status }, description };
}

function makeClient(taskPayload, versions, calls = []) {
  return {
    getTask: async () => taskPayload,
    getVersionsByList: async () => versions,
    createTask: async (listId, data) => {
      calls.push(["create", listId, data]);
      return { id: `new-${data.name}` };
    },
    updateCustomField: async (taskId, fieldId, value) => {
      calls.push(["field", taskId, fieldId, value]);
    },
  };
}

test("version utils parse, bump, and find max", () => {
  assert.deepEqual(parseVersion("1.0.3"), [1, 0, 3]);
  assert.equal(parseVersion("no version"), null);
  assert.equal(bumpVersion("1.0.3"), "1.0.4");
  assert.equal(bumpVersion("2.9.9"), "2.9.10");
  assert.equal(bumpVersion("abc"), "1.0.1");
  assert.equal(maxVersionName(["1.0.2", "1.0.10", "1.0.3"]), "1.0.10");
  assert.equal(maxVersionName([]), "1.0.0");
});

test("assignment keeps an existing target version", async () => {
  const calls = [];
  const client = makeClient(task("task-1", "1.0.3"), [], calls);
  const result = await assignTaskVersion({
    taskId: "task-1",
    client,
    config: CONFIG,
    taskListKey: "taskSandbox",
    versionListKey: "versionSandbox",
    codex: { run: async () => {
      throw new Error("AI must not run without an unreleased version");
    } },
    now: "2026-08-04T00:00:00.000Z",
  });
  assert.equal(result.versionName, "1.0.3");
  assert.equal(result.assigned, false);
  assert.equal(calls.length, 0);
});

test("assignment keeps an existing relationship target version", async () => {
  const calls = [];
  const client = makeClient(
    task("task-relationship", [{ id: "v-1.0.3", name: "1.0.3" }]),
    [],
    calls,
  );
  const result = await assignTaskVersion({
    taskId: "task-relationship",
    client,
    config: CONFIG,
    taskListKey: "taskSandbox",
    versionListKey: "versionSandbox",
    codex: { run: async () => ({ exitCode: 0, stdout: "{}" }) },
    now: "2026-08-04T00:00:00.000Z",
  });
  assert.equal(result.versionName, "1.0.3");
  assert.equal(result.assigned, false);
  assert.equal(calls.length, 0);
});

test("assignment joins the single unreleased version", async () => {
  const calls = [];
  let aiCalls = 0;
  const client = makeClient(
    task("task-2"),
    [version("1.0.3", "进行中")],
    calls,
  );
  const result = await assignTaskVersion({
    taskId: "task-2",
    client,
    config: CONFIG,
    taskListKey: "taskSandbox",
    versionListKey: "versionSandbox",
    codex: { run: async () => {
      aiCalls += 1;
      return { exitCode: 0, stdout: '{"version":"1.0.3"}' };
    } },
    now: "2026-08-04T00:00:00.000Z",
  });
  assert.equal(result.versionName, "1.0.3");
  assert.equal(result.assigned, true);
  assert.equal(aiCalls, 1);
  assert.equal(calls[0][0], "field");
  assert.deepEqual(calls[0][3], { add: ["v-1.0.3"], rem: [] });
});

test("assignment blocks when there is no current development version", async () => {
  const calls = [];
  const client = makeClient(
    task("task-3"),
    [version("1.0.3", "已发布")],
    calls,
  );
  const result = await assignTaskVersion({
    taskId: "task-3",
    client,
    config: CONFIG,
    taskListKey: "taskSandbox",
    versionListKey: "versionSandbox",
    codex: { run: async () => ({ exitCode: 0, stdout: "{}" }) },
    now: "2026-08-04T00:00:00.000Z",
  });
  assert.equal(result.error, "no current development version");
  assert.equal(result.assigned, false);
  assert.deepEqual(calls, []);
});

test("assignment lets AI choose a future version from all unreleased versions", async () => {
  const calls = [];
  const client = makeClient(
    task("task-4"),
    [version("1.0.3", "进行中"), version("1.0.4", "进行中")],
    calls,
  );
  const result = await assignTaskVersion({
    taskId: "task-4",
    client,
    config: CONFIG,
    taskListKey: "taskSandbox",
    versionListKey: "versionSandbox",
    codex: {
      run: async ({ prompt }) => {
        assert.match(prompt, /任务名称：任务/);
        assert.match(prompt, /任务描述：需求描述/);
        assert.match(prompt, /1\.0\.3/);
        assert.match(prompt, /1\.0\.4/);
        return { exitCode: 0, stdout: '{"version":"1.0.4"}' };
      },
    },
    now: "2026-08-04T00:00:00.000Z",
  });
  assert.equal(result.versionName, "1.0.4");
  assert.equal(result.assigned, true);
  assert.deepEqual(calls[0][3], { add: ["v-1.0.4"], rem: [] });
});

test("assignment rejects an AI version outside the unreleased list without writing", async () => {
  const calls = [];
  const client = makeClient(
    task("task-invalid-choice"),
    [version("1.0.3", "进行中"), version("1.0.4", "进行中")],
    calls,
  );
  const result = await assignTaskVersion({
    taskId: "task-invalid-choice",
    client,
    config: CONFIG,
    taskListKey: "taskSandbox",
    versionListKey: "versionSandbox",
    codex: { run: async () => ({ exitCode: 0, stdout: '{"version":"1.0.5"}' }) },
  });
  assert.equal(result.error, "version decision failed");
  assert.equal(result.assigned, false);
  assert.deepEqual(calls, []);
});

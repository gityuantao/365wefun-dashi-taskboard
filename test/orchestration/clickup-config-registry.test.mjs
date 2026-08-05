import assert from "node:assert/strict";
import test from "node:test";
import {
  fieldId,
  loadClickUpConfig,
  resolveTaskStatus,
  resolveVersionStatus,
} from "../../orchestration/clickup/config-registry.mjs";

const VALID_CONFIG = {
  teamId: "90161712199",
  spaceId: "90167718544",
  lists: {
    task: { id: "901616282651", name: "任务" },
    version: { id: "901616282740", name: "版本" },
    taskSandbox: { id: "901616314492", name: "任务-Sandbox" },
    versionSandbox: { id: "901616314494", name: "版本-Sandbox" },
  },
  taskStatusMap: {
    收件箱: "inbox",
    分析中: "analyzing",
    待开发: "ready_for_development",
    开发中: "developing",
    待测试: "ready_for_test",
    测试中: "testing",
    待验收: "ready_for_acceptance",
    验收中: "accepting",
    待发布: "ready_for_release",
    已发布: "published",
    已取消: "canceled",
  },
  versionStatusMap: {
    规划中: "planning",
    进行中: "active",
    待发布: "ready_for_release",
    发布中: "releasing",
    发布失败: "release_failed",
    已发布: "published",
    已取消: "canceled",
  },
  fields: {
    task: {
      自动化纳管: { id: "368e6e92-8193-492c-9e82-d293e5d236e0", type: "checkbox" },
      执行摘要: { id: "ee42cba2-e092-45bd-b0d0-7fc22c12db85", type: "text" },
    },
    version: {
      操作请求: { id: "beacbfd2-5dff-49e6-9919-fef1a490d0f9", type: "drop_down" },
      "Release Commit": { id: "5ccd4a44-4ddb-41ac-a8b1-d6b23fe39e0c", type: "short_text" },
    },
  },
};

test("config registry accepts a valid configuration and freezes it", () => {
  const config = loadClickUpConfig(VALID_CONFIG);
  assert.equal(config.teamId, "90161712199");
  assert.equal(config.lists.task.id, "901616282651");
  assert.equal(config.lists.taskSandbox.id, "901616314492");
  assert.ok(Object.isFrozen(config));
});

test("config registry rejects missing required sections", () => {
  for (const missing of ["teamId", "spaceId", "lists", "taskStatusMap", "versionStatusMap"]) {
    const copy = { ...VALID_CONFIG };
    delete copy[missing];
    assert.throws(() => loadClickUpConfig(copy), /INVALID_CONFIG/, `missing ${missing}`);
  }
  assert.throws(
    () => loadClickUpConfig({ ...VALID_CONFIG, lists: { ...VALID_CONFIG.lists, task: {} } }),
    /INVALID_CONFIG/,
  );
});

test("task status mapping resolves every ClickUp status to the canonical state", () => {
  const config = loadClickUpConfig(VALID_CONFIG);
  assert.equal(resolveTaskStatus(config, "收件箱"), "inbox");
  assert.equal(resolveTaskStatus(config, "验收中"), "accepting");
  assert.equal(resolveTaskStatus(config, "待发布"), "ready_for_release");
  assert.equal(resolveTaskStatus(config, "已发布"), "published");
  assert.throws(() => resolveTaskStatus(config, "不存在状态"), /UNKNOWN_STATUS/);
});

test("version status mapping resolves canonical states", () => {
  const config = loadClickUpConfig(VALID_CONFIG);
  assert.equal(resolveVersionStatus(config, "规划中"), "planning");
  assert.equal(resolveVersionStatus(config, "发布中"), "releasing");
  assert.equal(resolveVersionStatus(config, "发布失败"), "release_failed");
  assert.throws(() => resolveVersionStatus(config, "不存在状态"), /UNKNOWN_STATUS/);
});

test("config registry rejects status maps with duplicate canonical states", () => {
  const duplicate = {
    ...VALID_CONFIG,
    taskStatusMap: { ...VALID_CONFIG.taskStatusMap, 重复映射: "inbox" },
  };
  assert.throws(() => loadClickUpConfig(duplicate), /DUPLICATE_CANONICAL_STATE/);
});

test("field id lookup returns stable ids and rejects unknown fields", () => {
  const config = loadClickUpConfig(VALID_CONFIG);
  assert.equal(
    fieldId(config, "task", "自动化纳管"),
    "368e6e92-8193-492c-9e82-d293e5d236e0",
  );
  assert.equal(fieldId(config, "version", "操作请求"), "beacbfd2-5dff-49e6-9919-fef1a490d0f9");
  assert.throws(() => fieldId(config, "task", "不存在的字段"), /UNKNOWN_FIELD/);
  assert.throws(() => fieldId(config, "project", "自动化纳管"), /UNKNOWN_FIELD/);
});

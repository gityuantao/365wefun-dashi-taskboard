import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProductionPlatformsSupported,
  resolveProductionPlatforms,
} from "../../orchestration/release/platform-gate.mjs";

function assertInvalidScope(value) {
  assert.throws(
    () => resolveProductionPlatforms(value),
    (error) => error.code === "INVALID_PRODUCTION_PLATFORM_SCOPE",
  );
}

test("production platform gate aggregates explicit Web, API, and iOS task scope", () => {
  const platforms = resolveProductionPlatforms([
    { taskId: "web-task", platforms: ["web"] },
    { taskId: "api-task", platforms: ["api"] },
    { taskId: "ios-task", platforms: ["ios"] },
  ]);

  assert.deepEqual(platforms, {
    web: true,
    api: true,
    ios: true,
    unsupported: [],
  });
});

test("production platform gate marks Android and mini-program scope unsupported", () => {
  const platforms = resolveProductionPlatforms([
    { taskId: "android-task", platforms: ["android"] },
    { taskId: "mini-task", platforms: ["mini-program"] },
  ]);

  assert.deepEqual(platforms, {
    web: false,
    api: false,
    ios: false,
    unsupported: ["android", "mini-program"],
  });
});

test("production platform gate rejects incomplete and malformed task scope with a stable DomainError", () => {
  for (const snapshots of [null, {}, [], [null], [{}], [{ platforms: null }], [{ platforms: [] }]]) {
    assertInvalidScope(snapshots);
  }
  assertInvalidScope([{ platforms: ["   "] }]);
  assertInvalidScope([{ platforms: ["web", null] }]);
});

test("production platform support boundary rejects unsupported scope before the adapter operation", () => {
  let adapterCalls = 0;

  assert.throws(
    () => {
      const platforms = assertProductionPlatformsSupported([
        { taskId: "android-task", platforms: ["android"] },
      ]);
      adapterCalls += 1;
      return platforms;
    },
    (error) => error.code === "UNSUPPORTED_PRODUCTION_PLATFORM" && error.details?.unsupported?.[0] === "android",
  );
  assert.equal(adapterCalls, 0);
});

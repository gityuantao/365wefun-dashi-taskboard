import assert from "node:assert/strict";
import test from "node:test";

import { resolveProductionPlatforms } from "../../orchestration/release/platform-gate.mjs";

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

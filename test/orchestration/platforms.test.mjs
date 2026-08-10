import assert from "node:assert/strict";
import test from "node:test";

import { resolveTaskPlatforms } from "../../orchestration/domain/platforms.mjs";

test("production-shaped ClickUp option ids resolve through option labels", () => {
  const task = {
    custom_fields: [{
      id: "field-platforms",
      name: "影响平台",
      value: ["platform-web", "platform-ios"],
      type_config: {
        options: [
          { id: "platform-web", label: "Web" },
          { id: "platform-ios", label: "iOS" },
        ],
      },
    }],
  };

  assert.deepEqual(resolveTaskPlatforms(task), ["web", "ios"]);
});

test("scalar ClickUp option ids resolve through option names", () => {
  const task = {
    custom_fields: [{
      id: "field-platforms",
      name: "影响平台",
      value: "platform-ios",
      type_config: {
        options: [{ id: "platform-ios", name: "iOS" }],
      },
    }],
  };

  assert.deepEqual(resolveTaskPlatforms(task), ["ios"]);
});

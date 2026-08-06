import assert from "node:assert/strict";
import test from "node:test";
import {
  correctionText,
  stateChangeText,
} from "../../orchestration/clickup/state-comments.mjs";

test("version release comments use the direct active-to-releasing flow", () => {
  assert.equal(stateChangeText("version", "active", "releasing"), "开始发布");
  assert.equal(stateChangeText("version", "releasing", "published"), "发布成功");
  assert.equal(stateChangeText("version", "releasing", "release_failed"), "发布失败");
});

test("version corrections after release are silent", () => {
  assert.equal(correctionText("version", "published", "releasing"), null);
  assert.equal(correctionText("version", "release_failed", "releasing"), null);
  assert.match(correctionText("version", "active", "releasing"), /未全部就绪/);
});

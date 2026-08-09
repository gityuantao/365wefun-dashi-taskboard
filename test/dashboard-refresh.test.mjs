import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../web/src/components/dashboard/Dashboard.tsx", import.meta.url),
  "utf8",
);

test("dashboard refresh ignores stale responses", () => {
  assert.match(source, /const loadGenerationRef = useRef\(0\)/);
  assert.match(source, /const generation = \+\+loadGenerationRef\.current/);
  assert.match(source, /generation !== loadGenerationRef\.current/);
});

test("dashboard detail ignores stale responses", () => {
  assert.match(source, /const detailGenerationRef = useRef\(0\)/);
  assert.match(source, /const generation = \+\+detailGenerationRef\.current/);
  assert.match(source, /generation !== detailGenerationRef\.current/);
});

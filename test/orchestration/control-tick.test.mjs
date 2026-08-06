import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../../scripts/orchestrator.mjs", import.meta.url), "utf8");

test("orchestrator gates tick processing on the control switch", () => {
  assert.match(source, /import \{[^}]*readControl[^}]*\} from "\.\.\/orchestration\/control\.mjs"/);
  assert.match(source, /async function tick\(\)[\s\S]*?readControl\(CONTROL_PATH\)/);
  assert.match(source, /shouldProcess\(control\)[\s\S]*?log\("orchestration paused"\)/);
  assert.match(source, /startDashboardServer\(\{[\s\S]*?controlPath: CONTROL_PATH/);
});

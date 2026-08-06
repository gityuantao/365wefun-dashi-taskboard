import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");

test("dashboard is the default view with no old board entry", () => {
  assert.match(appSource, /import \{ Dashboard \} from "\.\/components\/dashboard\/Dashboard"/);
  assert.match(appSource, /useState<"dashboard" \| "issues">\("dashboard"\)/);
  assert.match(appSource, /运营驾驶舱/);
  assert.match(appSource, /viewMode === "dashboard" \? <Dashboard \/> : \(/);
  assert.match(appSource, /viewMode === "issues" && selectedProjectId \? \(/);
  assert.match(appSource, /viewMode === "issues" && <div className="project-nav">/);
  assert.match(appSource, /event\.key\.toLowerCase\(\) === "c"[\s\S]*?viewMode === "issues"[\s\S]*?selectedProjectId[\s\S]*?boardView === "issues"/);
  assert.match(appSource, /event\.key === "\/" && viewMode === "issues" && !detailTaskId && selectedProjectId && boardView === "issues"/);
  assert.match(appSource, /!editor[\s\S]*?viewMode === "issues"/);
  assert.match(appSource, /\[boardView, contextMenu, detailTaskId, editor, projectMenuOpen, selectedProjectId, viewMode\]/);
  assert.doesNotMatch(appSource, />\s*议题看板\s*<\/button>/);
});

test("dashboard keeps an embedded drag region without rendering board chrome", () => {
  assert.match(appSource, /viewMode === "dashboard" \? \(/);
  assert.match(appSource, /className="workspace-header">\n\s*<div ref=\{dragRegionRef\} className="workspace-drag-region"/);
});

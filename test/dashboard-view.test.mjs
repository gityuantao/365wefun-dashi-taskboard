import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");

test("dashboard is the default view with no old board entry", () => {
  assert.match(appSource, /import \{ Dashboard \} from "\.\/components\/dashboard\/Dashboard"/);
  assert.match(appSource, /useState<"dashboard" \| "issues">\("dashboard"\)/);
  assert.match(appSource, /<Dashboard \/>/);
  assert.match(appSource, /viewMode === "dashboard" \? <Dashboard \/> : \(/);
  assert.match(appSource, /viewMode === "issues" && selectedProjectId \? \(/);
  assert.doesNotMatch(appSource, /className="app-nav"/);
  assert.match(appSource, /event\.key\.toLowerCase\(\) === "c"[\s\S]*?viewMode === "issues"[\s\S]*?selectedProjectId[\s\S]*?boardView === "issues"/);
  assert.match(appSource, /event\.key === "\/" && viewMode === "issues" && !detailTaskId && selectedProjectId && boardView === "issues"/);
  assert.match(appSource, /!editor[\s\S]*?viewMode === "issues"/);
  assert.match(appSource, /\[boardView, contextMenu, detailTaskId, editor, projectMenuOpen, selectedProjectId, viewMode\]/);
  assert.doesNotMatch(appSource, />\s*议题看板\s*<\/button>/);
});

test("dashboard keeps an invisible drag region without board chrome", () => {
  assert.match(appSource, /className="home-window-drag-region"/);
  assert.doesNotMatch(appSource, /className="workspace-header">\n\s*<div ref=\{dragRegionRef\} className="workspace-drag-region"/);
});

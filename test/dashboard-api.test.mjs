import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../web/src/types.ts", import.meta.url), "utf8");

test("api client exposes orchestration dashboard endpoints", () => {
  assert.match(apiSource, /export async function getOrchestrationDashboard/);
  assert.match(apiSource, /\/api\/orchestration\/dashboard"/);
  assert.match(apiSource, /export async function getOrchestrationTaskDetail/);
  assert.match(apiSource, /\/api\/orchestration\/dashboard\/tasks\//);
  assert.match(apiSource, /export async function getOrchestrationVersionDetail/);
  assert.match(apiSource, /\/api\/orchestration\/dashboard\/versions\//);
});

test("types include dashboard payload and detail shapes", () => {
  for (const name of [
    "DashboardPayload",
    "ReleasableVersion",
    "PipelineCounts",
    "VersionProgress",
    "ActivityItem",
    "TaskDetail",
    "VersionDetail",
    "TimelineEntry",
  ]) {
    assert.match(typesSource, new RegExp(`export interface ${name}`));
  }
});

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

test("dashboard types carry contract-critical fields", () => {
  assert.match(typesSource, /export interface ReleasableVersion[\s\S]*?releaseFailed: boolean;/);
  assert.match(typesSource, /export interface DashboardPayload[\s\S]*?activity: ActivityItem\[\];/);
  assert.match(typesSource, /export interface TaskDetail[\s\S]*?acceptanceResult: "accepted" \| "rejected" \| null;/);
  assert.match(typesSource, /export interface VersionDetail[\s\S]*?manifest: \{[\s\S]*?checksum: string;/);
});

test("control api and version fields are typed", () => {
  assert.match(typesSource, /export interface OrchestrationControl[\s\S]*?enabled: boolean;/);
  assert.match(typesSource, /export interface VersionProgress[\s\S]*?hasOpenBlockers: boolean;/);
  assert.match(typesSource, /export interface VersionProgress[\s\S]*?notReadyCount: number;/);
  assert.match(apiSource, /export async function getOrchestrationControl/);
  assert.match(apiSource, /export async function setOrchestrationControl/);
  assert.match(apiSource, /\/api\/orchestration\/control"/);
});

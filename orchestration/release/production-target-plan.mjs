import { isDeepStrictEqual } from "node:util";

import { DomainError } from "../domain/errors.mjs";
import { enabledIosApps, loadIosApps } from "../ios/app-registry.mjs";
import { enabledMiniProgramApps, loadMiniProgramApps } from "../mini-program/app-registry.mjs";
import { assertProductionPlatformsSupported } from "./platform-gate.mjs";

const IOS_TARGET_FIELDS = Object.freeze([
  "id",
  "name",
  "appStoreAppId",
  "scheme",
  "bundleId",
  "marketingVersion",
  "testScheme",
  "testTarget",
  "buildNumberSource",
  "releaseMode",
  "reviewConfigurationRef",
  "testFlightGroup",
]);
const MINI_PROGRAM_TARGET_FIELDS = Object.freeze([
  "id", "name", "appId", "sourceDirectory", "buildCommand", "artifactDirectory",
  "uploadCommand", "reviewCommand", "releaseCommand", "readbackCommand",
  "credentialsPath", "reviewConfigurationRef",
]);

function invalid(message) {
  throw new DomainError("INVALID_PRODUCTION_TARGET_PLAN", message);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

export function buildProductionTargetPlan({
  taskSnapshots,
  taskIds,
  apps = [],
  marketingVersion,
  miniProgramApps = [],
  candidateScope = null,
}) {
  const expectedIds = Array.isArray(taskIds) ? taskIds : [];
  const snapshotsById = new Map(taskSnapshots.map((snapshot) => [snapshot?.id, snapshot]));
  if (
    snapshotsById.size !== expectedIds.length
    || expectedIds.some((taskId) => !snapshotsById.has(taskId))
  ) {
    invalid("production task snapshot scope does not exactly match the release task ids");
  }
  const orderedSnapshots = expectedIds.map((taskId) => snapshotsById.get(taskId));
  const resolved = assertProductionPlatformsSupported(orderedSnapshots);
  const taskPlatforms = orderedSnapshots.map((snapshot) => ({
    taskId: snapshot.id,
    platforms: snapshot.platforms.map((platform) => platform.trim().toLowerCase()),
    ...(candidateScope ? {
      source: snapshot.source ?? "missing",
      evidenceId: snapshot.evidenceId ?? null,
      commitSha: snapshot.commitSha ?? null,
      acceptedCommitSha: snapshot.acceptedCommitSha ?? null,
      aggregateVersion: snapshot.aggregateVersion ?? null,
      androidDelivery: snapshot.androidDelivery ?? null,
    } : {}),
  }));
  let iosApps = [];
  if (resolved.ios) {
    const originals = new Map(apps.map((app) => [app?.id, app]));
    iosApps = enabledIosApps(loadIosApps(apps)).map((app) => {
      const target = {
        ...app,
        marketingVersion: originals.get(app.id)?.marketingVersion ?? marketingVersion,
      };
      for (const field of IOS_TARGET_FIELDS) {
        if (!nonEmpty(target[field])) invalid(`iOS production target ${field} is required`);
      }
      return Object.fromEntries(IOS_TARGET_FIELDS.map((field) => [field, target[field]]));
    });
  }
  if (!candidateScope) return {
    schemaVersion: 1,
    taskPlatforms,
    platforms: {
      web: resolved.web,
      api: resolved.api,
      ios: resolved.ios,
      ...(resolved.mini_program ? { mini_program: true } : {}),
    },
    iosApps,
  };
  let frozenMiniProgramApps = [];
  if (resolved.mini_program) {
    frozenMiniProgramApps = enabledMiniProgramApps(loadMiniProgramApps(miniProgramApps))
      .map((app) => Object.fromEntries(MINI_PROGRAM_TARGET_FIELDS.map((field) => [field, app[field]])));
  }
  const hasAndroidTwa = candidateScope.platforms?.includes("android_twa")
    || orderedSnapshots.some((snapshot) => snapshot.platforms.includes("android_twa"));
  const nodes = [];
  if (resolved.web || hasAndroidTwa) nodes.push({ id: "web", platform: "web", appId: "" });
  if (resolved.api) nodes.push({ id: "api", platform: "api", appId: "" });
  for (const app of iosApps) nodes.push({ id: `ios:${app.id}`, platform: "ios", appId: app.id });
  for (const app of frozenMiniProgramApps) nodes.push({ id: `mini_program:${app.id}`, platform: "mini_program", appId: app.id });
  if (hasAndroidTwa) nodes.push({ id: "android_twa", platform: "android_twa", appId: "" });
  return {
    schemaVersion: 2,
    mappingVersion: candidateScope.mappingVersion,
    candidateScope: structuredClone(candidateScope),
    taskPlatforms,
    platforms: {
      web: resolved.web || hasAndroidTwa,
      api: resolved.api,
      ios: resolved.ios,
      mini_program: resolved.mini_program,
      android_twa: hasAndroidTwa,
    },
    iosApps,
    miniProgramApps: frozenMiniProgramApps,
    androidTwa: { enabled: hasAndroidTwa, sourceDirectory: "apps/android-web-wrapper/", dependsOn: "web" },
    dag: { nodes, edges: hasAndroidTwa ? [{ from: "web", to: "android_twa" }] : [] },
  };
}

export function assertProductionTargetPlanMatches(expected, actual) {
  if (!isDeepStrictEqual(actual, expected)) {
    invalid("production target plan drifted from the frozen Manifest");
  }
  return expected;
}

export function taskSnapshotsFromProductionTargetPlan(plan) {
  return plan.taskPlatforms.map(({ taskId, platforms }) => ({ id: taskId, platforms: [...platforms] }));
}

export function iosAppsFromProductionTargetPlan(plan) {
  return plan.iosApps.map((app) => ({ ...app, enabled: true }));
}

export function miniProgramAppsFromProductionTargetPlan(plan) {
  return (plan.miniProgramApps ?? []).map((app) => ({ ...app, enabled: true }));
}

export function validateProductionTargetPlan(plan, taskIds) {
  if (plan?.schemaVersion === 1) {
    try {
      const rebuilt = buildProductionTargetPlan({
        taskSnapshots: plan?.taskPlatforms?.map(({ taskId, platforms }) => ({ id: taskId, platforms })),
        taskIds, apps: plan?.iosApps?.map((app) => ({ ...app, enabled: true })), marketingVersion: null,
      });
      return isDeepStrictEqual(rebuilt, plan) ? [] : ["production target plan is not canonical"];
    } catch (error) { return [error.message]; }
  }
  try {
    const rebuilt = buildProductionTargetPlan({
      taskSnapshots: plan?.taskPlatforms?.map(({ taskId, ...snapshot }) => ({ id: taskId, ...snapshot })),
      taskIds,
      apps: plan?.iosApps?.map((app) => ({ ...app, enabled: true })),
      miniProgramApps: plan?.miniProgramApps?.map((app) => ({ ...app, enabled: true })),
      marketingVersion: null,
      candidateScope: plan?.candidateScope,
    });
    return isDeepStrictEqual(rebuilt, plan) ? [] : ["production target plan is not canonical"];
  } catch (error) {
    return [error.message];
  }
}

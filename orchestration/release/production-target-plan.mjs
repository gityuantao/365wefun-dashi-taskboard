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
const CANONICAL_TARGETS = Object.freeze(["api", "ios", "mini_program", "web"]);

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
  plannedTargets = null,
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
  const wantsIos = candidateScope && Array.isArray(plannedTargets)
    ? plannedTargets.includes("ios")
    : resolved.ios;
  if (wantsIos) {
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
  if (!Array.isArray(plannedTargets)
    || plannedTargets.length === 0
    || plannedTargets.some((target) => !CANONICAL_TARGETS.includes(target))
    || new Set(plannedTargets).size !== plannedTargets.length
    || !isDeepStrictEqual([...plannedTargets].sort(), plannedTargets)) {
    invalid("canonical plannedTargets are required in sorted unique order");
  }
  const planned = new Set(plannedTargets);
  for (const platform of CANONICAL_TARGETS) {
    const required = resolved[platform];
    if (required && !planned.has(platform)) {
      invalid(`canonical plannedTargets omit task platform ${platform}`);
    }
  }
  let frozenMiniProgramApps = [];
  if (planned.has("mini_program")) {
    if (!nonEmpty(marketingVersion)) invalid("mini-program production target version is required");
    frozenMiniProgramApps = enabledMiniProgramApps(loadMiniProgramApps(miniProgramApps))
      .map((app) => ({
        ...Object.fromEntries(MINI_PROGRAM_TARGET_FIELDS.map((field) => [field, app[field]])),
        version: marketingVersion,
        versionSource: "release_snapshot_name",
        description: `Candidate ${candidateScope.candidateCommit}`,
      }));
  }
  const hasAndroidTwa = candidateScope.platforms?.includes("android_twa")
    || orderedSnapshots.some((snapshot) => snapshot.platforms.includes("android_twa"));
  if (hasAndroidTwa && !planned.has("web")) {
    invalid("canonical plannedTargets must project Android TWA to web");
  }
  const nodes = [];
  if (planned.has("web")) nodes.push({
    id: "web", platform: "web", appId: "", successCondition: "authoritative_readback",
    readbackIdentity: { candidateCommit: candidateScope.candidateCommit },
  });
  if (planned.has("api")) nodes.push({
    id: "api", platform: "api", appId: "", successCondition: "authoritative_readback",
    readbackIdentity: { candidateCommit: candidateScope.candidateCommit },
  });
  for (const app of iosApps) nodes.push({
    id: `ios:${app.id}`, platform: "ios", appId: app.id,
    successCondition: "authoritative_live_readback",
    readbackIdentity: {
      appStoreAppId: app.appStoreAppId, bundleId: app.bundleId, version: app.marketingVersion,
    },
  });
  for (const app of frozenMiniProgramApps) nodes.push({
    id: `mini_program:${app.id}`, platform: "mini_program", appId: app.id,
    successCondition: "authoritative_live_readback",
    readbackIdentity: { appId: app.appId, version: app.version },
  });
  if (hasAndroidTwa) nodes.push({
    id: "android_twa", platform: "android_twa", appId: "",
    successCondition: "authoritative_live_readback",
    readbackIdentity: { candidateCommit: candidateScope.candidateCommit },
  });
  return {
    schemaVersion: 2,
    mappingVersion: candidateScope.mappingVersion,
    candidateScope: structuredClone(candidateScope),
    plannedTargets: [...plannedTargets],
    taskPlatforms,
    platforms: {
      web: planned.has("web"),
      api: planned.has("api"),
      ios: planned.has("ios"),
      mini_program: planned.has("mini_program"),
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
      miniProgramApps: plan?.miniProgramApps?.map((app) => ({
        ...Object.fromEntries(MINI_PROGRAM_TARGET_FIELDS.map((field) => [field, app?.[field]])),
        enabled: true,
      })),
      marketingVersion: plan?.miniProgramApps?.[0]?.version ?? null,
      candidateScope: plan?.candidateScope,
      plannedTargets: plan?.plannedTargets,
    });
    return isDeepStrictEqual(rebuilt, plan) ? [] : ["production target plan is not canonical"];
  } catch (error) {
    return [error.message];
  }
}

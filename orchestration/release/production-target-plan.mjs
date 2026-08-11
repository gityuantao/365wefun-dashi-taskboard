import { isDeepStrictEqual } from "node:util";

import { DomainError } from "../domain/errors.mjs";
import { enabledIosApps, loadIosApps } from "../ios/app-registry.mjs";
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
  return {
    schemaVersion: 1,
    taskPlatforms,
    platforms: { web: resolved.web, api: resolved.api, ios: resolved.ios },
    iosApps,
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

export function validateProductionTargetPlan(plan, taskIds) {
  try {
    const rebuilt = buildProductionTargetPlan({
      taskSnapshots: plan?.taskPlatforms?.map(({ taskId, platforms }) => ({ id: taskId, platforms })),
      taskIds,
      apps: plan?.iosApps?.map((app) => ({ ...app, enabled: true })),
      marketingVersion: null,
    });
    return isDeepStrictEqual(rebuilt, plan) ? [] : ["production target plan is not canonical"];
  } catch (error) {
    return [error.message];
  }
}

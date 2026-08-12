#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";

import { resolveSatisfiedReworkBlockers } from "../orchestration/application/blocker-reconciliation.mjs";
import { buildVersionDetail } from "../orchestration/dashboard/queries.mjs";
import { createProductionRuntime } from "../orchestration/release/production-runtime.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function safeApps(apps) {
  return (apps ?? []).map(({ id, name, appStoreAppId, scheme, bundleId }) => ({
    id, name, appStoreAppId, scheme, bundleId,
  }));
}

export async function reconcileReleaseReadiness({
  db,
  versionId,
  runtimeBoundary,
  applyBlockers = false,
  now = new Date().toISOString(),
}) {
  const version = await db.prepare(`SELECT snapshot FROM clickup_snapshots
    WHERE object_type='version' AND object_id=?`).bind(versionId).first();
  if (!version) throw new Error(`version not found: ${versionId}`);
  const versionSnapshot = JSON.parse(version.snapshot);
  const taskRows = (await db.prepare("SELECT snapshot,status FROM clickup_snapshots WHERE object_type='task'").all()).results;
  const matching = taskRows.map((row) => ({ ...JSON.parse(row.snapshot), status: row.status }))
    .filter((task) => task.targetVersion === (versionSnapshot.name ?? versionId));
  const excludedCanceledTaskIds = matching.filter((task) => task.status === "canceled").map((task) => task.id).sort();
  const activeTaskIds = matching.filter((task) => task.status !== "canceled").map((task) => task.id).sort();

  const eligible = [];
  const resolved = [];
  const skipped = [];
  for (const taskId of activeTaskIds) {
    const outcome = await resolveSatisfiedReworkBlockers({ db, taskId, now, dryRun: !applyBlockers });
    eligible.push(...outcome.eligible.map((item) => ({ taskId, ...item })));
    resolved.push(...outcome.resolved.map((item) => ({ taskId, ...item })));
    skipped.push(...outcome.skipped.map((item) => ({ taskId, ...item })));
  }

  const configuredIosApps = safeApps(runtimeBoundary?.configuredApps);
  const detail = await buildVersionDetail(db, versionId, { iosApps: configuredIosApps });
  return {
    versionId,
    versionName: detail.name,
    excludedCanceledTaskIds,
    activeTaskIds,
    blockers: { eligible, resolved, skipped },
    taskPlatforms: detail.taskPlatforms,
    configuredIosApps,
    held: runtimeBoundary?.readiness?.held === true,
    runtimeError: runtimeBoundary?.readiness?.error ?? null,
    releaseReadiness: detail.releaseReadiness,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const applyBlockers = args.includes("--apply-blockers");
  const versionIndex = args.indexOf("--version-id");
  const versionId = versionIndex >= 0 ? args[versionIndex + 1] : null;
  if (!versionId) throw new Error("--version-id is required");
  const runtimePath = path.join(PROJECT_ROOT, ".data", "orchestration.json");
  if (!existsSync(runtimePath)) throw new Error("local orchestration runtime is missing");
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
  const runtimeBoundary = createProductionRuntime({
    runtime,
    projectRoot: PROJECT_ROOT,
  });
  const miniflare = new Miniflare({
    modules: true,
    scriptPath: path.join(PROJECT_ROOT, "cloud", "src", "index.mjs"),
    modulesRoot: PROJECT_ROOT,
    compatibilityDate: "2026-07-24",
    bindings: { TASKBOARD_ENVIRONMENT: "production", TASKBOARD_SHARED_SECRET: "orchestration-local" },
    d1Databases: { DB: "orchestration-db" },
    r2Buckets: { ATTACHMENTS: "orchestration-attachments" },
    defaultPersistRoot: path.join(PROJECT_ROOT, ".data", "orchestration-d1"),
    d1Persist: true,
    r2Persist: true,
  });
  try {
    await miniflare.ready;
    const db = await miniflare.getD1Database("DB");
    const result = await reconcileReleaseReadiness({ db, versionId, runtimeBoundary, applyBlockers });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await miniflare.dispose();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

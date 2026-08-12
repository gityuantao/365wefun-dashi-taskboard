import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import { loadLastConfirmed } from "../clickup/snapshot.mjs";
import { validateProductionTargetPlan } from "./production-target-plan.mjs";
import {
  activeVersionTasks,
  loadReleasePlatformEvidence,
} from "./release-scope.mjs";
import { buildReleaseEligibility } from "./release-eligibility.mjs";

export async function loadAllTaskSnapshots(db) {
  const rows = await db
    .prepare("SELECT snapshot FROM clickup_snapshots WHERE object_type = 'task'")
    .all();
  return rows.results.map((row) => JSON.parse(row.snapshot));
}

export async function checkVersionGate({ db, versionId, candidateScope = null, runtimeReadiness = { ready: true } }) {
  const versionSnapshot = await loadLastConfirmed(db, "version", versionId);
  const matchKey = versionSnapshot?.name ?? versionId;
  const manifestRow = await db.prepare("SELECT manifest FROM release_manifests WHERE version_id = ?").bind(versionId).first();
  const manifest = manifestRow?.manifest ? JSON.parse(manifestRow.manifest) : null;
  const allTasks = await loadAllTaskSnapshots(db);
  const aggregates = await db.prepare("SELECT aggregate_id, aggregate_version, state FROM orchestration_aggregates WHERE aggregate_type = 'task'").all();
  const aggregateById = new Map(aggregates.results.map((row) => [row.aggregate_id, row]));
  for (const task of allTasks) {
    const aggregate = aggregateById.get(task.id);
    task.aggregateVersion = aggregate?.aggregate_version ?? null;
    task.status = task.status ?? aggregate?.state ?? null;
  }
  const tasks = activeVersionTasks({ tasks: allTasks, versionName: matchKey, manifest });
  const resolvedTasks = [];
  for (const task of tasks) {
    const aggregate = await loadAggregate(db, "task", task.id);
    const state = aggregate.state ?? task.status;
    resolvedTasks.push({ ...task, status: state });
  }
  const blockers = await db
    .prepare("SELECT object_id FROM blockers WHERE status = 'open' AND object_type = 'task'")
    .all();
  const blockedIds = new Set(blockers.results.map((row) => row.object_id));
  const taskPlatforms = await loadReleasePlatformEvidence(db, tasks);
  const eligibility = buildReleaseEligibility({
    version: versionSnapshot ?? { id: versionId },
    tasks: resolvedTasks,
    blockers: [...blockedIds],
    platformEvidence: taskPlatforms,
    candidateScope: candidateScope ?? manifest?.candidateScope ?? null,
    configuredTargets: ["web", "api", "ios", "mini_program"],
    runtimeReadiness,
  });
  return {
    pass: eligibility.ready,
    reasons: eligibility.gaps,
    releaseEligibility: eligibility,
    taskIds: eligibility.taskIds,
    taskPlatforms: eligibility.taskPlatforms,
  };
}

function checksum(value) {
  const json = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function hasArtifactIdentity(value) {
  if (nonEmptyString(value)) return true;
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

export function validateFrozenManifest(manifest) {
  const reasons = [];
  if (!manifest || typeof manifest !== "object") {
    return ["frozen manifest is missing"];
  }
  if (!nonEmptyString(manifest.versionBranch)) {
    reasons.push("version branch is missing");
  }
  if (!/^[0-9a-f]{40,64}$/i.test(manifest.candidateCommit ?? "")) {
    reasons.push("Candidate commit is missing or invalid");
  }
  if (!/^refs\/heads\/release-candidate\/[A-Za-z0-9._/-]+$/.test(manifest.candidateRef ?? "")) {
    reasons.push("immutable remote Candidate ref is missing or invalid");
  }
  if (!Array.isArray(manifest.taskIds) || manifest.taskIds.length === 0) {
    reasons.push("Candidate has no task ids");
  }
  const taskIds = Array.isArray(manifest.taskIds) ? manifest.taskIds : [];
  const heads = Array.isArray(manifest.taskPrHeads) ? manifest.taskPrHeads : [];
  const headTaskIds = heads.map((head) => head?.taskId);
  const exactHeads = heads.length === taskIds.length
    && new Set(headTaskIds).size === taskIds.length
    && taskIds.every((taskId) => headTaskIds.includes(taskId))
    && heads.every((head) => nonEmptyString(head?.branch)
      && /^[0-9a-f]{40,64}$/i.test(head?.headCommit ?? "")
      && Number.isInteger(head?.prNumber)
      && head.prNumber > 0
      && nonEmptyString(head?.repository));
  if (!exactHeads) {
    reasons.push("exact task PR heads are missing");
  }
  if (!hasArtifactIdentity(manifest.artifactIdentity)) {
    reasons.push("artifact identity is missing");
  }
  if (!manifest.regressionEvidence || manifest.regressionEvidence.passed !== true) {
    reasons.push("passing regression evidence is missing");
  }
  reasons.push(...validateProductionTargetPlan(manifest.productionTargetPlan, taskIds));
  if (nonEmptyString(manifest.checksum)) {
    const { checksum: storedChecksum, ...withoutChecksum } = manifest;
    if (storedChecksum !== checksum(withoutChecksum)) {
      reasons.push("Manifest checksum does not match its frozen contents");
    }
  }
  return reasons;
}

export async function freezeManifest({
  db,
  versionId,
  now,
  versionBranch,
  candidateCommit,
  candidateRef,
  taskPrHeads,
  artifactIdentity,
  regressionEvidence,
  productionTargetPlan,
  candidateScope = null,
}) {
  const existing = await loadManifest({ db, versionId });
  if (existing) {
    return { status: "already_frozen", manifest: existing };
  }
  const gate = await checkVersionGate({ db, versionId, candidateScope });
  if (!gate.pass) {
    return { status: "rejected", reasons: gate.reasons };
  }
  const manifestWithoutChecksum = {
    versionId,
    versionBranch,
    candidateCommit,
    candidateRef,
    taskIds: gate.taskIds,
    taskPrHeads,
    artifactIdentity,
    regressionEvidence,
    productionTargetPlan,
    releaseEligibility: gate.releaseEligibility,
    candidateScope: gate.releaseEligibility.candidateScope,
    createdAt: now,
  };
  const reasons = validateFrozenManifest(manifestWithoutChecksum);
  if (reasons.length > 0) {
    return { status: "rejected", reasons };
  }
  const manifest = {
    ...manifestWithoutChecksum,
    checksum: checksum(manifestWithoutChecksum),
  };
  await db
    .prepare(
      "INSERT INTO release_manifests (version_id, manifest, created_at) VALUES (?, ?, ?)",
    )
    .bind(versionId, JSON.stringify(manifest), now)
    .run();

  return { status: "frozen", manifest };
}

export async function loadManifest({ db, versionId }) {
  const row = await db
    .prepare("SELECT manifest FROM release_manifests WHERE version_id = ?")
    .bind(versionId)
    .first();
  return row ? JSON.parse(row.manifest) : null;
}

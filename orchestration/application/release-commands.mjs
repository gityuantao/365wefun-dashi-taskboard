import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseCommandEnvelope } from "../domain/commands.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import {
  loadAllTaskSnapshots,
  loadManifest,
  validateFrozenManifest,
} from "../release/version-aggregator.mjs";
import { assertProductionPlatformsSupported } from "../release/platform-gate.mjs";
import {
  assertProductionTargetPlanMatches,
  buildProductionTargetPlan,
  iosAppsFromProductionTargetPlan,
  taskSnapshotsFromProductionTargetPlan,
} from "../release/production-target-plan.mjs";
import { dispatchCommand } from "./dispatch-command.mjs";
import { executeProductionRelease } from "./production-release-coordinator.mjs";
import { stateChangeText } from "../clickup/state-comments.mjs";

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function immutableManifestSnapshot(manifest) {
  return deepFreeze(structuredClone(manifest));
}

export async function loadCleanupAttempts({ db, versionId, candidateCommit, taskId }) {
  const rows = await db
    .prepare(
      `SELECT id, version_id, candidate_commit, task_id, branch, step,
              attempt, status, result, error, attempted_at
       FROM release_cleanup_attempts
       WHERE version_id = ? AND candidate_commit = ? AND task_id = ?
       ORDER BY rowid`,
    )
    .bind(versionId, candidateCommit, taskId)
    .all();
  return rows.results.map((row) => ({
    id: row.id,
    versionId: row.version_id,
    candidateCommit: row.candidate_commit,
    taskId: row.task_id,
    branch: row.branch,
    step: row.step,
    attempt: row.attempt,
    status: row.status,
    result: JSON.parse(row.result),
    error: row.error,
    attemptedAt: row.attempted_at,
  }));
}

export async function recordCleanupAttempt({
  db,
  versionId,
  candidateCommit,
  taskId,
  branch,
  step,
  status,
  result = {},
  error = null,
  now,
}) {
  const previous = await db
    .prepare(
      `SELECT COALESCE(MAX(attempt), 0) AS attempt
       FROM release_cleanup_attempts
       WHERE version_id = ? AND candidate_commit = ? AND task_id = ? AND step = ?`,
    )
    .bind(versionId, candidateCommit, taskId, step)
    .first();
  const attempt = Number(previous?.attempt ?? 0) + 1;
  const id = `cleanup-${versionId}-${candidateCommit}-${taskId}-${step}-${attempt}`;
  await db
    .prepare(
      `INSERT INTO release_cleanup_attempts (
        id, version_id, candidate_commit, task_id, branch, step,
        attempt, status, result, error, attempted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      versionId,
      candidateCommit,
      taskId,
      branch,
      step,
      attempt,
      status,
      JSON.stringify(result),
      error,
      now,
    )
    .run();
  return { id, versionId, candidateCommit, taskId, branch, step, attempt, status, result, error, attemptedAt: now };
}

export async function loadTaskPullRequest({ db, taskId }) {
  const row = await db
    .prepare(
      `SELECT result FROM runner_jobs
       WHERE job_type = 'develop'
         AND status = 'completed'
         AND json_extract(payload, '$.taskId') = ?
         AND result IS NOT NULL
       ORDER BY completed_at DESC LIMIT 1`,
    )
    .bind(taskId)
    .first();
  if (!row?.result) return null;
  try {
    return JSON.parse(row.result)?.pr?.url ?? null;
  } catch {
    return null;
  }
}

export async function confirmPublishedCandidate({ adapter, manifest, deployment = null }) {
  const publication = await adapter.readback({ manifest, deployment });
  if (
    publication?.confirmed !== true
    || publication?.published !== true
    || publication?.authoritative !== true
    || !["published", "live"].includes(publication?.status)
    || publication?.healthStatus !== "healthy"
    || publication?.readbackStatus !== "confirmed"
    || publication?.candidateCommit !== manifest.candidateCommit
    || !isDeepStrictEqual(publication?.artifactIdentity, manifest.artifactIdentity)
  ) {
    throw new Error("Candidate readback did not confirm the exact frozen Candidate and artifact");
  }
  return publication;
}

export async function handleConfirmRelease({
  db,
  versionId,
  actorId,
  actorRoles = [],
  now,
  adapter,
  webAdapter = adapter,
  miniProgramAdapter = null,
  iosAdapter = null,
  apps = null,
  platforms = null,
  targetPlanValidated = false,
  lease = null,
  client,
  dispatch = dispatchCommand,
  executeRelease = executeProductionRelease,
}) {
  if (!actorRoles.some((role) => ["release_manager", "admin"].includes(role))) {
    return { status: "rejected", error: "UNAUTHORIZED: release_manager role required" };
  }
  const storedManifest = await loadManifest({ db, versionId });
  if (!storedManifest) {
    return { status: "rejected", error: "version has no frozen manifest" };
  }
  const manifest = immutableManifestSnapshot(storedManifest);
  const manifestReasons = validateFrozenManifest(manifest);
  if (manifestReasons.length > 0) {
    return {
      status: "rejected",
      error: `version frozen manifest is incomplete: ${manifestReasons.join("; ")}`,
    };
  }
  const frozenTaskSnapshots = taskSnapshotsFromProductionTargetPlan(manifest.productionTargetPlan);
  const frozenApps = iosAppsFromProductionTargetPlan(manifest.productionTargetPlan);
  if (!targetPlanValidated) {
    const currentTaskSnapshots = platforms ?? (await loadAllTaskSnapshots(db)).filter(
      (snapshot) => manifest.taskIds.includes(snapshot.id),
    );
    try {
      const currentPlan = buildProductionTargetPlan({
        taskSnapshots: currentTaskSnapshots,
        taskIds: manifest.taskIds,
        apps: apps ?? [],
        marketingVersion: frozenApps[0]?.marketingVersion,
      });
      assertProductionTargetPlanMatches(manifest.productionTargetPlan, currentPlan);
    } catch (error) {
      return { status: "rejected", error: error.message };
    }
  }
  let resolvedPlatforms;
  try {
    resolvedPlatforms = assertProductionPlatformsSupported(frozenTaskSnapshots);
  } catch (error) {
    return { status: "rejected", error: error.message };
  }
  if (
    (resolvedPlatforms.web || resolvedPlatforms.api)
    && (
      !webAdapter
      || webAdapter.placeholder === true
      || typeof webAdapter.release !== "function"
      || typeof webAdapter.readback !== "function"
    )
  ) {
    return { status: "rejected", error: "release adapter/deployer is not configured" };
  }
  if (
    resolvedPlatforms.mini_program
    && (
      !miniProgramAdapter
      || miniProgramAdapter.placeholder === true
      || typeof miniProgramAdapter.release !== "function"
      || typeof miniProgramAdapter.readback !== "function"
    )
  ) {
    return { status: "rejected", error: "mini-program release adapter/deployer is not configured" };
  }
  if (
    resolvedPlatforms.ios
    && (
      !iosAdapter
      || iosAdapter.placeholder === true
      || typeof iosAdapter.release !== "function"
      || typeof iosAdapter.readback !== "function"
    )
  ) {
    return { status: "rejected", error: "iOS release adapter is not configured" };
  }
  const version = await loadAggregate(db, "version", versionId);
  const attempt = Date.now();
  if (version.state !== "releasing" && version.state !== "published") {
    try {
      await dispatch({
        db,
        command: parseCommandEnvelope({
          id: `release-start-${versionId}-${attempt}`,
          type: "start_release",
          aggregateType: "version",
          aggregateId: versionId,
          expectedVersion: version.version + 1,
          actorId,
          issuedAt: now,
          reason: "confirmed release",
          parameters: { evidenceId: `release-attempt-${versionId}-${attempt}` },
        }),
        now,
      });
    } catch (error) {
      return { status: "failed", stage: "start_release", error: error.message };
    }
    const startComment = stateChangeText("version", version.state, "releasing");
    if (startComment && client) {
      try {
        await client.postComment(versionId, startComment);
      } catch {
        // 评论失败不影响发布
      }
    }
  }

  const deployments = new Map();
  const persistentWebAdapter = (resolvedPlatforms.web || resolvedPlatforms.api) ? {
    release: async (options) => {
      const released = await webAdapter.release(options);
      deployments.set(options.platform, released);
      return released;
    },
    readback: async (options) => {
      const persistedLocator = options.readbackLocator
        ?? options.deployment?.observedEvidence
        ?? options.deployment;
      const readbackLocator = deployments.get(options.platform) ?? persistedLocator;
      const publication = await webAdapter.readback({
        ...options,
        deployment: options.deployment,
        readbackLocator,
      });
      return publication;
    },
  } : null;
  const persistentMiniProgramAdapter = resolvedPlatforms.mini_program ? {
    release: async (options) => {
      const released = await miniProgramAdapter.release(options);
      deployments.set(options.platform, released);
      return released;
    },
    readback: async (options) => {
      const persistedLocator = options.readbackLocator
        ?? options.deployment?.observedEvidence
        ?? options.deployment;
      const readbackLocator = deployments.get(options.platform) ?? persistedLocator;
      return miniProgramAdapter.readback({
        ...options,
        deployment: options.deployment,
        readbackLocator,
      });
    },
  } : null;

  const activeLease = lease ?? {
    holder: `release:${versionId}:${actorId}:${randomUUID()}`,
    durationMs: 10 * 60_000,
  };
  let productionResult;
  try {
    productionResult = await executeRelease({
      db,
      manifest,
      platforms: frozenTaskSnapshots,
      apps: frozenApps,
      webAdapter: persistentWebAdapter,
      miniProgramAdapter: persistentMiniProgramAdapter,
      iosAdapter,
      lease: activeLease,
      now,
    });
    if (productionResult.status === "waiting_external") {
      return productionResult;
    }
    if (productionResult.status === "failed") {
      const error = new Error(productionResult.error ?? "production release failed");
      error.failureFingerprint = productionResult.failureFingerprint;
      throw error;
    }
    for (const taskId of manifest.taskIds) {
      const task = await loadAggregate(db, "task", taskId);
      if (task.state === "published") continue;
      await dispatch({
        db,
        command: parseCommandEnvelope({
          id: `publish-task-${taskId}`,
          type: "publish_task",
          aggregateType: "task",
          aggregateId: taskId,
          expectedVersion: task.version + 1,
          actorId,
          issuedAt: now,
          reason: "version published",
          parameters: {},
        }),
        now,
      });
    }
    const releasing = await loadAggregate(db, "version", versionId);
    if (releasing.state !== "published") {
      await dispatch({
        db,
        command: parseCommandEnvelope({
          id: `release-succeeded-${versionId}-${attempt}`,
          type: "release_succeeded",
          aggregateType: "version",
          aggregateId: versionId,
          expectedVersion: releasing.version + 1,
          actorId,
          issuedAt: now,
          reason: "release succeeded",
          parameters: {},
        }),
        now,
      });
      const okComment = stateChangeText("version", "releasing", "published");
      if (okComment && client) {
        try {
          await client.postComment(versionId, okComment);
        } catch {
          // 评论失败不影响发布结果
        }
      }
    }
    return {
      status: "succeeded",
      result: productionResult,
      publication: productionResult.publication,
    };
  } catch (error) {
    const failed = await loadAggregate(db, "version", versionId);
    if (failed.state === "releasing") {
      try {
        await dispatch({
          db,
          command: parseCommandEnvelope({
            id: `release-failed-${versionId}-${attempt}`,
            type: "release_failed",
            aggregateType: "version",
            aggregateId: versionId,
            expectedVersion: failed.version + 1,
            actorId,
            issuedAt: now,
            reason: "release failed",
            parameters: {
              evidenceId: error.failureFingerprint
                ? `production-release-failure-${error.failureFingerprint}`
                : `release-failure-${versionId}-${attempt}`,
            },
          }),
          now,
        });
      } catch (dispatchError) {
        return {
          status: "failed",
          stage: "release_failed",
          error: error.message,
          dispatchError: dispatchError.message,
        };
      }
    }
    const failComment = stateChangeText("version", "releasing", "release_failed", error.message);
    if (failComment && client) {
      try {
        await client.postComment(versionId, failComment);
      } catch {
        // 评论失败不影响发布结果
      }
    }
    return { status: "failed", error: error.message };
  }
}

export async function coordinateVersionRelease({
  versionId,
  versionBranch,
  taskIds,
  now,
  existingManifest = null,
  publicationAlreadyConfirmed = false,
  integrateTaskPr,
  collectRegressionEvidence,
  identifyArtifact,
  persistCandidate,
  resolveCandidateBase = null,
  freezeCandidate,
  verifyCandidate,
  publishCandidate,
  cleanupTask,
  cleanupOperations = null,
  loadCleanupAttempts: loadRecordedCleanup,
  recordCleanupAttempt: recordCleanup,
}) {
  let manifest = existingManifest;
  if (!manifest) {
    const taskPrHeads = [];
    let candidateCommit = null;
    let candidateSourceRef = null;
    const candidateBaseCommits = [];
    for (const taskId of taskIds) {
      const integrated = await integrateTaskPr({ taskId, versionBranch });
      if (!integrated?.merged || !integrated.taskHead || !integrated.candidateCommit) {
        return {
          status: "failed",
          stage: "integration",
          error: `failed to integrate task PR ${taskId}: ${integrated?.error ?? "unknown error"}`,
        };
      }
      candidateCommit = integrated.candidateCommit;
      candidateSourceRef = integrated.candidateSourceRef ?? versionBranch;
      if (integrated.candidateBaseCommit) candidateBaseCommits.push(integrated.candidateBaseCommit);
      taskPrHeads.push({
        taskId,
        branch: integrated.headRefName,
        headCommit: integrated.taskHead,
        prNumber: integrated.prNumber,
        repository: integrated.repository,
      });
    }

    const base = candidateBaseCommits.length === 0
      ? { resolved: true, candidateBaseCommit: candidateCommit }
      : typeof resolveCandidateBase === "function"
      ? await resolveCandidateBase({ candidateCommit, candidateBaseCommits })
      : candidateBaseCommits.length > 0
        ? { resolved: true, candidateBaseCommit: candidateBaseCommits[0] }
        : { resolved: true, candidateBaseCommit: candidateCommit };
    if (base?.resolved !== true || (!base.candidateBaseCommit && taskIds.length > 0)) {
      return { status: "failed", stage: "candidate_base", error: base?.error ?? "Candidate base could not be resolved" };
    }
    const candidateBaseCommit = base.candidateBaseCommit;
    const regressionEvidence = await collectRegressionEvidence({
      versionId,
      versionBranch,
      candidateCommit,
    });
    if (regressionEvidence?.passed !== true) {
      return {
        status: "failed",
        stage: "regression",
        error: "version regression evidence did not pass",
      };
    }
    const artifactIdentity = await identifyArtifact({
      versionId,
      versionBranch,
      candidateCommit,
      regressionEvidence,
    });
    const persisted = await persistCandidate({
      versionId,
      versionBranch,
      candidateCommit,
      candidateSourceRef,
      candidateBaseCommit,
      taskPrHeads,
    });
    if (persisted?.persisted !== true || !persisted.candidateRef) {
      return {
        status: "failed",
        stage: "candidate_persistence",
        error: persisted?.error ?? "Candidate remote persistence failed",
      };
    }
    const frozen = await freezeCandidate({
      versionId,
      versionBranch,
      candidateCommit,
      candidateRef: persisted.candidateRef,
      candidateBaseCommit,
      taskPrHeads,
      artifactIdentity,
      regressionEvidence,
      now,
    });
    if (!frozen || !["frozen", "already_frozen"].includes(frozen.status)) {
      return {
        status: frozen?.status ?? "failed",
        stage: "freeze",
        error: frozen?.reasons?.join("; ") ?? "Candidate freeze failed",
      };
    }
    manifest = frozen.manifest;
  }

  let publication = {
    status: "succeeded",
    publication: { candidateCommit: manifest.candidateCommit },
  };
  if (!publicationAlreadyConfirmed) {
    const verified = await verifyCandidate({ manifest });
    if (verified?.verified !== true) {
      return {
        status: "failed",
        stage: "candidate_verification",
        error: verified?.error ?? "frozen Candidate integration could not be verified",
      };
    }

    publication = await publishCandidate({ manifest });
    if (publication?.status !== "succeeded") {
      return publication ?? { status: "failed", error: "publication failed" };
    }
    if (publication.publication?.candidateCommit !== manifest.candidateCommit) {
      return { status: "failed", error: "published Candidate does not match frozen Candidate" };
    }
  }

  const cleanupResult = {
    status: "completed",
    versionId,
    candidateCommit: manifest.candidateCommit,
    recordedAt: now,
    tasks: [],
  };
  for (const head of manifest.taskPrHeads) {
    if (cleanupOperations && loadRecordedCleanup && recordCleanup) {
      const previous = await loadRecordedCleanup({
        versionId,
        candidateCommit: manifest.candidateCommit,
        taskId: head.taskId,
      });
      const taskResult = { taskId: head.taskId, branch: head.branch, steps: [] };
      cleanupResult.tasks.push(taskResult);
      for (const operation of cleanupOperations) {
        const succeeded = previous.find(
          (attempt) => attempt.step === operation.name && attempt.status === "succeeded",
        );
        if (succeeded) {
          taskResult.steps.push({ ...succeeded, reused: true });
          continue;
        }
        try {
          const stepResult = await operation.run({ head, manifest });
          const recorded = await recordCleanup({
            versionId,
            candidateCommit: manifest.candidateCommit,
            taskId: head.taskId,
            branch: head.branch,
            step: operation.name,
            status: "succeeded",
            result: stepResult,
            now,
          });
          taskResult.steps.push(recorded);
          previous.push(recorded);
        } catch (error) {
          cleanupResult.status = "partial";
          const recorded = await recordCleanup({
            versionId,
            candidateCommit: manifest.candidateCommit,
            taskId: head.taskId,
            branch: head.branch,
            step: operation.name,
            status: "failed",
            error: error.message,
            now,
          });
          taskResult.steps.push(recorded);
          break;
        }
      }
      continue;
    }
    try {
      const result = await cleanupTask({
        taskId: head.taskId,
        branch: head.branch,
        candidateCommit: manifest.candidateCommit,
      });
      cleanupResult.tasks.push({ status: "succeeded", ...result });
    } catch (error) {
      cleanupResult.status = "partial";
      cleanupResult.tasks.push({
        status: "failed",
        taskId: head.taskId,
        branch: head.branch,
        error: error.message,
      });
    }
  }
  return { ...publication, manifest, cleanupResult };
}

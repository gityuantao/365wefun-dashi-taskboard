import { isDeepStrictEqual } from "node:util";
import { parseCommandEnvelope } from "../domain/commands.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import {
  loadManifest,
  validateFrozenManifest,
} from "../release/version-aggregator.mjs";
import { dispatchCommand } from "./dispatch-command.mjs";
import { stateChangeText } from "../clickup/state-comments.mjs";

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
  client,
  dispatch = dispatchCommand,
}) {
  if (!actorRoles.some((role) => ["release_manager", "admin"].includes(role))) {
    return { status: "rejected", error: "UNAUTHORIZED: release_manager role required" };
  }
  const manifest = await loadManifest({ db, versionId });
  if (!manifest) {
    return { status: "rejected", error: "version has no frozen manifest" };
  }
  const manifestReasons = validateFrozenManifest(manifest);
  if (manifestReasons.length > 0) {
    return {
      status: "rejected",
      error: `version frozen manifest is incomplete: ${manifestReasons.join("; ")}`,
    };
  }
  if (
    !adapter
    || adapter.placeholder === true
    || typeof adapter.release !== "function"
    || typeof adapter.readback !== "function"
  ) {
    return { status: "rejected", error: "release adapter/deployer is not configured" };
  }
  const version = await loadAggregate(db, "version", versionId);
  const attempt = Date.now();
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

  try {
    const result = await adapter.release({ manifest });
    const publication = await confirmPublishedCandidate({ adapter, manifest, deployment: result });
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
    return { status: "succeeded", result, publication };
  } catch (error) {
    const failed = await loadAggregate(db, "version", versionId);
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
          parameters: { evidenceId: `release-failure-${versionId}-${Date.now()}` },
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
  integrateTaskPr,
  collectRegressionEvidence,
  identifyArtifact,
  persistCandidate,
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
      taskPrHeads.push({
        taskId,
        branch: integrated.headRefName,
        headCommit: integrated.taskHead,
        prNumber: integrated.prNumber,
        repository: integrated.repository,
      });
    }

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

  const verified = await verifyCandidate({ manifest });
  if (verified?.verified !== true) {
    return {
      status: "failed",
      stage: "candidate_verification",
      error: verified?.error ?? "frozen Candidate integration could not be verified",
    };
  }

  const publication = await publishCandidate({ manifest });
  if (publication?.status !== "succeeded") {
    return publication ?? { status: "failed", error: "publication failed" };
  }
  if (publication.publication?.candidateCommit !== manifest.candidateCommit) {
    return { status: "failed", error: "published Candidate does not match frozen Candidate" };
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

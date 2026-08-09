import { isDeepStrictEqual } from "node:util";
import { parseCommandEnvelope } from "../domain/commands.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import {
  loadManifest,
  validateFrozenManifest,
} from "../release/version-aggregator.mjs";
import { dispatchCommand } from "./dispatch-command.mjs";
import { stateChangeText } from "../clickup/state-comments.mjs";

export async function handleConfirmRelease({
  db,
  versionId,
  actorId,
  actorRoles = [],
  now,
  adapter,
  client,
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
  await dispatchCommand({
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
    const publication = await adapter.readback({ manifest, deployment: result });
    if (
      publication?.confirmed !== true
      || publication?.published !== true
      || publication?.candidateCommit !== manifest.candidateCommit
      || !isDeepStrictEqual(publication?.artifactIdentity, manifest.artifactIdentity)
    ) {
      throw new Error("Candidate readback did not confirm the exact frozen Candidate and artifact");
    }
    const releasing = await loadAggregate(db, "version", versionId);
    await dispatchCommand({
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
    for (const taskId of manifest.taskIds) {
      const task = await loadAggregate(db, "task", taskId);
      await dispatchCommand({
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
    await dispatchCommand({
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
  freezeCandidate,
  verifyCandidate,
  publishCandidate,
  cleanupTask,
}) {
  let manifest = existingManifest;
  if (!manifest) {
    const taskPrHeads = [];
    let candidateCommit = null;
    for (const taskId of taskIds) {
      const branch = `task/${taskId}`;
      const integrated = await integrateTaskPr({ taskId, taskBranch: branch, versionBranch });
      if (!integrated?.merged || !integrated.taskHead || !integrated.candidateCommit) {
        return {
          status: "failed",
          stage: "integration",
          error: `failed to integrate task PR ${taskId}: ${integrated?.error ?? "unknown error"}`,
        };
      }
      candidateCommit = integrated.candidateCommit;
      taskPrHeads.push({ taskId, branch, headCommit: integrated.taskHead });
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
    const frozen = await freezeCandidate({
      versionId,
      versionBranch,
      candidateCommit,
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

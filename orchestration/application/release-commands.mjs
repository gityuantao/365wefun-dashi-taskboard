import { parseCommandEnvelope } from "../domain/commands.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import { loadManifest } from "../release/version-aggregator.mjs";
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
    return { status: "succeeded", result };
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

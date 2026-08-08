import { fieldId } from "./config-registry.mjs";
import { loadLastConfirmed } from "./snapshot.mjs";

export async function enqueueMutation(db, {
  mutationId,
  objectType,
  objectId,
  field,
  expectedBefore,
  target,
  actor,
  expiresAt,
  createdAt,
}) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO outbox_mutations (
        id, object_type, object_id, field, expected_before, target, actor,
        status, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(
      mutationId,
      objectType,
      objectId,
      field,
      expectedBefore ?? null,
      JSON.stringify(target),
      actor,
      expiresAt,
      createdAt,
    )
    .run();
}

export async function confirmMutation(db, mutationId, confirmedAt) {
  await db
    .prepare(
      `UPDATE outbox_mutations
       SET status = 'confirmed', confirmed_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(confirmedAt, mutationId)
    .run();
}

function parseTarget(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function flushOutbox(db, client, { now, config }) {
  const rows = await db
    .prepare("SELECT * FROM outbox_mutations WHERE status = 'pending' ORDER BY created_at")
    .all();
  const flushed = [];
  const expired = [];
  for (const row of rows.results) {
    if (row.expires_at <= now) {
      await db
        .prepare("UPDATE outbox_mutations SET status = 'expired' WHERE id = ? AND status = 'pending'")
        .bind(row.id)
        .run();
      expired.push(row.id);
      continue;
    }
    const target = parseTarget(row.target);
    if (row.field === "status") {
      if (row.object_type === "task") {
        const snapshot = await loadLastConfirmed(db, "task", row.object_id);
        const targetState = config.taskStatusMap[target];
        let authoritativeState = snapshot?.status ?? null;
        if (typeof client.getTask === "function") {
          const remote = await client.getTask(row.object_id);
          const remoteStatusName = remote?.status?.status === "to do"
            ? "收件箱"
            : remote?.status?.status;
          authoritativeState = config.taskStatusMap[remoteStatusName] ?? remoteStatusName ?? null;
        }
        const expectedState = config.taskStatusMap[row.expected_before]
          ?? row.expected_before
          ?? null;
        const preconditionFailed = expectedState !== null
          && authoritativeState !== null
          && authoritativeState !== expectedState;
        const manualPauseConflict = authoritativeState === "waiting_info"
          && targetState !== "waiting_info";
        if (preconditionFailed || manualPauseConflict) {
          await db
            .prepare(
              "UPDATE outbox_mutations SET status = 'expired' WHERE id = ? AND status = 'pending'",
            )
            .bind(row.id)
            .run();
          expired.push(row.id);
          continue;
        }
      }
      await client.updateTaskStatus(row.object_id, target);
    } else {
      const id = fieldId(config, row.object_type, row.field);
      await client.updateCustomField(row.object_id, id, target);
    }
    await confirmMutation(db, row.id, now);
    flushed.push(row.id);
  }
  return { flushed, expired };
}

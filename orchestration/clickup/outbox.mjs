import { fieldId } from "./config-registry.mjs";
import { DomainError } from "../domain/errors.mjs";
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
      expectedBefore === null || expectedBefore === undefined
        ? null
        : JSON.stringify(expectedBefore),
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

function normalizedEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeStatus(value, config, objectType) {
  let normalized = value;
  while (normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)) {
    if (!("status" in normalized)) break;
    normalized = normalized.status;
  }
  if (normalized === null || normalized === undefined || normalized === "") return null;
  if (normalized === "to do") normalized = "收件箱";
  const statusMap = objectType === "version"
    ? config.versionStatusMap
    : config.taskStatusMap;
  return statusMap[normalized] ?? normalized;
}

function normalizeCustomField(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizeCustomField);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeCustomField(value[key])]),
  );
}

async function readRemoteValue(client, row, config, customFieldId) {
  if (typeof client.getTask !== "function") {
    throw new DomainError(
      "REMOTE_STATE_UNAVAILABLE",
      `Cannot establish remote state for mutation "${row.id}"`,
    );
  }
  const remote = await client.getTask(row.object_id);
  if (row.field === "status") {
    const status = normalizeStatus(remote?.status, config, row.object_type);
    if (status === null) {
      throw new DomainError(
        "REMOTE_STATE_UNAVAILABLE",
        `Remote status is unavailable for mutation "${row.id}"`,
      );
    }
    return status;
  }
  if (!Array.isArray(remote?.custom_fields)) {
    throw new DomainError(
      "REMOTE_STATE_UNAVAILABLE",
      `Remote custom fields are unavailable for mutation "${row.id}"`,
    );
  }
  const field = remote.custom_fields.find((candidate) => candidate?.id === customFieldId);
  return normalizeCustomField(field?.value ?? null);
}

async function expireMutation(db, mutationId) {
  await db
    .prepare("UPDATE outbox_mutations SET status = 'expired' WHERE id = ? AND status = 'pending'")
    .bind(mutationId)
    .run();
}

export async function flushOutbox(db, client, { now, config }) {
  const rows = await db
    .prepare("SELECT * FROM outbox_mutations WHERE status = 'pending' ORDER BY created_at")
    .all();
  const flushed = [];
  const expired = [];
  for (const row of rows.results) {
    if (row.expires_at <= now) {
      await expireMutation(db, row.id);
      expired.push(row.id);
      continue;
    }
    const target = parseTarget(row.target);
    const expected = parseTarget(row.expected_before);
    let customFieldId = null;
    let normalizedTarget;
    let normalizedExpected;
    if (row.field === "status") {
      normalizedTarget = normalizeStatus(target, config, row.object_type);
      normalizedExpected = normalizeStatus(expected, config, row.object_type);
      if (row.object_type === "task") {
        const snapshot = await loadLastConfirmed(db, "task", row.object_id);
        const snapshotState = normalizeStatus(snapshot?.status ?? null, config, row.object_type);
        if (snapshotState === "waiting_info" && normalizedTarget !== "waiting_info") {
          await expireMutation(db, row.id);
          expired.push(row.id);
          continue;
        }
      }
    } else {
      customFieldId = fieldId(config, row.object_type, row.field);
      normalizedTarget = normalizeCustomField(target);
      normalizedExpected = normalizeCustomField(expected);
    }

    const before = await readRemoteValue(client, row, config, customFieldId);
    const preconditionFailed = normalizedExpected !== null
      && !normalizedEqual(before, normalizedExpected);
    const manualPauseConflict = row.field === "status"
      && row.object_type === "task"
      && before === "waiting_info"
      && normalizedTarget !== "waiting_info";
    if (preconditionFailed || manualPauseConflict) {
      await expireMutation(db, row.id);
      expired.push(row.id);
      continue;
    }

    let writeError = null;
    try {
      if (row.field === "status") {
        await client.updateTaskStatus(row.object_id, target);
      } else {
        await client.updateCustomField(row.object_id, customFieldId, target);
      }
    } catch (error) {
      writeError = error;
    }

    const after = await readRemoteValue(client, row, config, customFieldId);
    if (normalizedEqual(after, normalizedTarget)) {
      await confirmMutation(db, row.id, now);
      flushed.push(row.id);
      continue;
    }
    if (normalizedExpected !== null && !normalizedEqual(after, normalizedExpected)) {
      await expireMutation(db, row.id);
      expired.push(row.id);
      continue;
    }
    if (writeError) throw writeError;
    throw new DomainError(
      "REMOTE_CONFIRMATION_FAILED",
      `Remote readback did not confirm mutation "${row.id}"`,
    );
  }
  return { flushed, expired };
}

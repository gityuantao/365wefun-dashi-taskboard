import { DomainError } from "../domain/errors.mjs";
import {
  fieldId,
  resolveTaskStatus,
  resolveVersionStatus,
} from "./config-registry.mjs";

function hashFields(value) {
  const json = JSON.stringify(sortValue(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sortValue(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortValue(value[key]);
  }
  return sorted;
}

function toNullableString(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  return String(value);
}

function customFieldMap(payload) {
  return new Map((payload.custom_fields ?? []).map((field) => [field.id, field]));
}

function fieldValue(custom, id) {
  return custom.get(id)?.value ?? null;
}

function managedBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

export function normalizeTask(payload, config) {
  if (!payload || typeof payload.id !== "string" || payload.id === "") {
    throw new DomainError("INVALID_PAYLOAD", "Task payload must include a non-empty id");
  }
  const status = resolveTaskStatus(config, payload.status?.status);
  const custom = customFieldMap(payload);
  const managed = managedBoolean(fieldValue(custom, fieldId(config, "task", "自动化纳管")));
  const operationRequest = toNullableString(fieldValue(custom, fieldId(config, "task", "操作请求")));
  const operationRequestId = toNullableString(
    fieldValue(custom, fieldId(config, "task", "操作请求ID")),
  );
  const targetVersion = toNullableString(fieldValue(custom, fieldId(config, "task", "目标版本")));
  const assignee = toNullableString(
    payload.assignees?.[0]?.username ?? payload.assignee?.username,
  );
  const keyFields = {
    status,
    managed,
    operationRequest,
    operationRequestId,
    targetVersion,
    assignee,
  };
  return {
    id: payload.id,
    listId: toNullableString(payload.list?.id),
    ...keyFields,
    updatedAt: toNullableString(payload.updated_at),
    fieldsHash: hashFields(keyFields),
  };
}

export function normalizeVersion(payload, config) {
  if (!payload || typeof payload.id !== "string" || payload.id === "") {
    throw new DomainError("INVALID_PAYLOAD", "Version payload must include a non-empty id");
  }
  const status = resolveVersionStatus(config, payload.status?.status);
  const custom = customFieldMap(payload);
  const operationRequest = toNullableString(
    fieldValue(custom, fieldId(config, "version", "操作请求")),
  );
  const blockedRaw = fieldValue(custom, fieldId(config, "version", "发布阻塞"));
  const blocked = blockedRaw === "已阻塞" || managedBoolean(blockedRaw);
  const keyFields = { status, operationRequest, blocked };
  return {
    id: payload.id,
    listId: toNullableString(payload.list?.id),
    ...keyFields,
    updatedAt: toNullableString(payload.updated_at),
    fieldsHash: hashFields(keyFields),
  };
}

export async function saveSnapshot(db, { type, snapshot, readAt } = {}) {
  const typeValue = type === "version" ? "version" : "task";
  await db
    .prepare(
      `INSERT INTO clickup_snapshots (
        object_type, object_id, list_id, status, snapshot, fields_hash, read_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(object_type, object_id) DO UPDATE SET
        list_id = excluded.list_id,
        status = excluded.status,
        snapshot = excluded.snapshot,
        fields_hash = excluded.fields_hash,
        read_at = excluded.read_at`,
    )
    .bind(
      typeValue,
      snapshot.id,
      snapshot.listId,
      snapshot.status,
      JSON.stringify(snapshot),
      snapshot.fieldsHash,
      readAt ?? snapshot.updatedAt ?? new Date().toISOString(),
    )
    .run();
}

export async function loadLastConfirmed(db, type, id) {
  const typeValue = type === "version" ? "version" : "task";
  const row = await db
    .prepare(
      `SELECT snapshot FROM clickup_snapshots
       WHERE object_type = ? AND object_id = ?`,
    )
    .bind(typeValue, id)
    .first();
  return row ? JSON.parse(row.snapshot) : null;
}

const COMPARED_FIELDS = [
  "status",
  "managed",
  "operationRequest",
  "operationRequestId",
  "targetVersion",
  "blocked",
];

export function compareSnapshots(confirmed, current) {
  if (!confirmed) {
    return [{ field: "status", from: null, to: current.status }];
  }
  const changes = [];
  for (const field of COMPARED_FIELDS) {
    const from = confirmed[field] ?? null;
    const to = current[field] ?? null;
    if (from !== to) {
      changes.push({ field, from, to });
    }
  }
  return changes;
}

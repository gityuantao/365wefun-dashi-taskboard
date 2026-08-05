import { DomainError } from "../domain/errors.mjs";
import {
  fieldConfig,
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

function dropdownName(field, value, options) {
  if (typeof value !== "string" && typeof value !== "number") return value;
  const candidates = [
    ...(field?.type_config?.options ?? []),
  ];
  const byId = new Map([
    ...candidates.map((option) => [option.id, option.name]),
    ...candidates.map((option, index) => [String(index), option.name]),
    ...Object.entries(options ?? {}),
    ...Object.entries(options ?? {}).map(([, name], index) => [String(index), name]),
  ]);
  const key = String(value);
  return byId.get(key) ?? (typeof value === "number" ? String(value) : value);
}

function managedBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

export function normalizeTask(payload, config, listKind = "task") {
  if (!payload || typeof payload.id !== "string" || payload.id === "") {
    throw new DomainError("INVALID_PAYLOAD", "Task payload must include a non-empty id");
  }
  const clickupStatus = payload.status?.status === "to do" ? "收件箱" : payload.status?.status;
  const status = resolveTaskStatus(config, clickupStatus);
  const custom = customFieldMap(payload);
  const targetVersion = toNullableString(
    fieldValue(custom, fieldId(config, listKind, "目标版本")),
  );
  const assignee = toNullableString(
    payload.assignees?.[0]?.username ?? payload.assignee?.username,
  );
  const keyFields = {
    status,
    targetVersion,
    assignee,
  };
  return {
    id: payload.id,
    listId: toNullableString(payload.list?.id),
    name: toNullableString(payload.name),
    ...keyFields,
    updatedAt: toNullableString(payload.updated_at),
    fieldsHash: hashFields(keyFields),
  };
}

export function normalizeVersion(payload, config, listKind = "version") {
  if (!payload || typeof payload.id !== "string" || payload.id === "") {
    throw new DomainError("INVALID_PAYLOAD", "Version payload must include a non-empty id");
  }
  const status = resolveVersionStatus(config, payload.status?.status);
  const custom = customFieldMap(payload);
  const requestField = custom.get(fieldId(config, listKind, "操作请求"));
  const operationRequest = toNullableString(dropdownName(
    requestField,
    requestField?.value ?? null,
    fieldConfig(config, listKind, "操作请求").options,
  ));
  const blockedField = custom.get(fieldId(config, listKind, "发布阻塞"));
  const blockedRaw = dropdownName(
    blockedField,
    blockedField?.value ?? null,
    fieldConfig(config, listKind, "发布阻塞").options,
  );
  const blocked = blockedRaw === "已阻塞" || managedBoolean(blockedRaw);
  const keyFields = { status, operationRequest, blocked };
  return {
    id: payload.id,
    listId: toNullableString(payload.list?.id),
    name: toNullableString(payload.name),
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
  "operationRequest",
  "operationRequestId",
  "targetVersion",
  "blocked",
  "updatedAt",
];

export function compareSnapshots(confirmed, current) {
  if (!confirmed) {
    const changes = [];
    for (const field of COMPARED_FIELDS) {
      const to = current[field] ?? null;
      if (to !== null) {
        changes.push({ field, from: null, to });
      }
    }
    return changes;
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

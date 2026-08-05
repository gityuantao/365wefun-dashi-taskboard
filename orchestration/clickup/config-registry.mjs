import { DomainError } from "../domain/errors.mjs";

export const LIST_KEYS = ["task", "version", "taskSandbox", "versionSandbox"];

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function assertConfigObject(value, message) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_CONFIG", message);
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("INVALID_CONFIG", `Config field "${field}" must be a non-empty string`, {
      field,
    });
  }
}

function validateStatusMap(map, label) {
  const canonicalValues = new Set();
  for (const [clickupName, canonical] of Object.entries(map)) {
    assertNonEmptyString(canonical, `${label}.${clickupName}`);
    if (canonicalValues.has(canonical)) {
      throw new DomainError(
        "DUPLICATE_CANONICAL_STATE",
        `Config ${label} maps multiple statuses to canonical state "${canonical}"`,
        { canonical },
      );
    }
    canonicalValues.add(canonical);
  }
}

export function loadClickUpConfig(value) {
  assertConfigObject(value, "ClickUp config must be a plain object");
  for (const key of ["teamId", "spaceId"]) {
    assertNonEmptyString(value[key], key);
  }
  assertConfigObject(value.lists, 'Config field "lists" must be an object');
  for (const key of LIST_KEYS) {
    const list = value.lists[key];
    assertConfigObject(list, `Config lists.${key} must be an object`);
    assertNonEmptyString(list.id, `lists.${key}.id`);
    assertNonEmptyString(list.name, `lists.${key}.name`);
  }
  assertConfigObject(value.taskStatusMap, 'Config field "taskStatusMap" must be an object');
  assertConfigObject(value.versionStatusMap, 'Config field "versionStatusMap" must be an object');
  validateStatusMap(value.taskStatusMap, "taskStatusMap");
  validateStatusMap(value.versionStatusMap, "versionStatusMap");

  const fields = value.fields ?? {};
  assertConfigObject(fields, 'Config field "fields" must be an object');
  for (const listKind of LIST_KEYS) {
    const entries = fields[listKind] ?? {};
    assertConfigObject(entries, `Config fields.${listKind} must be an object`);
    for (const [name, field] of Object.entries(entries)) {
      assertConfigObject(field, `Config fields.${listKind}.${name} must be an object`);
      assertNonEmptyString(field.id, `fields.${listKind}.${name}.id`);
      assertNonEmptyString(field.type, `fields.${listKind}.${name}.type`);
    }
  }

  const config = {
    teamId: value.teamId,
    spaceId: value.spaceId,
    lists: Object.fromEntries(
      LIST_KEYS.map((key) => [
        key,
        { id: value.lists[key].id, name: value.lists[key].name },
      ]),
    ),
    taskStatusMap: { ...value.taskStatusMap },
    versionStatusMap: { ...value.versionStatusMap },
    fields: {
      ...Object.fromEntries(
        LIST_KEYS.map((key) => [key, { ...(fields[key] ?? {}) }]),
      ),
    },
  };
  return deepFreeze(config);
}

export function resolveTaskStatus(config, clickupStatus) {
  const canonical = config.taskStatusMap[clickupStatus];
  if (canonical === undefined) {
    throw new DomainError(
      "UNKNOWN_STATUS",
      `Unknown task status "${clickupStatus}"`,
      { status: clickupStatus },
    );
  }
  return canonical;
}

export function resolveVersionStatus(config, clickupStatus) {
  const canonical = config.versionStatusMap[clickupStatus];
  if (canonical === undefined) {
    throw new DomainError(
      "UNKNOWN_STATUS",
      `Unknown version status "${clickupStatus}"`,
      { status: clickupStatus },
    );
  }
  return canonical;
}

export function fieldId(config, listKind, name) {
  const field = config.fields[listKind]?.[name];
  if (field === undefined) {
    throw new DomainError(
      "UNKNOWN_FIELD",
      `Unknown field "${name}" for list kind "${listKind}"`,
      { listKind, field: name },
    );
  }
  return field.id;
}

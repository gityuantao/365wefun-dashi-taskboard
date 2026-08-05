import { DomainError } from "./errors.mjs";

export const AGGREGATE_TYPES = new Set(["task", "version"]);
export const COMMAND_FIELDS = new Set([
  "id",
  "type",
  "aggregateType",
  "aggregateId",
  "expectedVersion",
  "actorId",
  "issuedAt",
  "reason",
  "parameters",
]);

const PARAMETERS_BYTE_LIMIT = 4 * 1024;
const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 4096) {
    throw new DomainError("INVALID_FIELD", `Command field "${field}" must be a non-empty string`, {
      field,
    });
  }
  return value;
}

function assertPlainObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_FIELD", `Command field "${field}" must be a plain object`, {
      field,
    });
  }
}

export function parseCommandEnvelope(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(
      "INVALID_FIELD",
      "Command envelope must be a plain object",
    );
  }
  for (const key of Object.keys(value)) {
    if (!COMMAND_FIELDS.has(key)) {
      throw new DomainError("UNKNOWN_FIELD", `Unknown command field "${key}"`, {
        field: key,
      });
    }
  }

  const id = nonEmptyString(value.id, "id");
  const type = nonEmptyString(value.type, "type");
  const aggregateType = nonEmptyString(value.aggregateType, "aggregateType");
  if (!AGGREGATE_TYPES.has(aggregateType)) {
    throw new DomainError(
      "INVALID_FIELD",
      `Command aggregateType must be one of ${[...AGGREGATE_TYPES].join(", ")}`,
      { field: "aggregateType" },
    );
  }
  const aggregateId = nonEmptyString(value.aggregateId, "aggregateId");
  if (!Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1) {
    throw new DomainError(
      "INVALID_FIELD",
      "Command expectedVersion must be a positive integer",
      { field: "expectedVersion" },
    );
  }
  const actorId = nonEmptyString(value.actorId, "actorId");
  const issuedAt = nonEmptyString(value.issuedAt, "issuedAt");
  if (!RFC3339_UTC_PATTERN.test(issuedAt) || !Number.isFinite(Date.parse(issuedAt))) {
    throw new DomainError(
      "INVALID_FIELD",
      "Command issuedAt must be an RFC3339 UTC timestamp",
      { field: "issuedAt" },
    );
  }
  const reason = nonEmptyString(value.reason, "reason");
  assertPlainObject(value.parameters, "parameters");
  const serializedParameters = JSON.stringify(value.parameters);
  if (new TextEncoder().encode(serializedParameters).length > PARAMETERS_BYTE_LIMIT) {
    throw new DomainError(
      "PARAMETERS_TOO_LARGE",
      `Command parameters exceed the ${PARAMETERS_BYTE_LIMIT} byte limit`,
      { limit: PARAMETERS_BYTE_LIMIT },
    );
  }

  return {
    id,
    type,
    aggregateType,
    aggregateId,
    expectedVersion: value.expectedVersion,
    actorId,
    issuedAt,
    reason,
    parameters: structuredClone(value.parameters),
  };
}

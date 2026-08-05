import { DomainError } from "./errors.mjs";
import { AGGREGATE_TYPES } from "./commands.mjs";

export const EVENT_FIELDS = new Set([
  "id",
  "sequence",
  "aggregateType",
  "aggregateId",
  "aggregateVersion",
  "type",
  "commandId",
  "actorId",
  "occurredAt",
  "data",
  "previousHash",
]);

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 4096) {
    throw new DomainError("INVALID_FIELD", `Event field "${field}" must be a non-empty string`, {
      field,
    });
  }
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DomainError(
      "INVALID_FIELD",
      `Event field "${field}" must be a positive integer`,
      { field },
    );
  }
}

function sortValue(value, seen) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sortValue(item, seen));
  if (seen.has(value)) throw new DomainError("INVALID_FIELD", "Event data must not be circular");
  seen.add(value);
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortValue(value[key], seen);
  }
  return sorted;
}

export function canonicalEventPayload(value) {
  const seen = new Set();
  return JSON.stringify(sortValue(value, seen));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createDomainEvent(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new DomainError("INVALID_FIELD", "Domain event must be a plain object");
  }
  for (const key of Object.keys(input)) {
    if (!EVENT_FIELDS.has(key)) {
      throw new DomainError("UNKNOWN_FIELD", `Unknown event field "${key}"`, { field: key });
    }
  }

  const id = nonEmptyString(input.id, "id");
  positiveInteger(input.sequence, "sequence");
  const aggregateType = nonEmptyString(input.aggregateType, "aggregateType");
  if (!AGGREGATE_TYPES.has(aggregateType)) {
    throw new DomainError(
      "INVALID_FIELD",
      `Event aggregateType must be one of ${[...AGGREGATE_TYPES].join(", ")}`,
      { field: "aggregateType" },
    );
  }
  const aggregateId = nonEmptyString(input.aggregateId, "aggregateId");
  positiveInteger(input.aggregateVersion, "aggregateVersion");
  const type = nonEmptyString(input.type, "type");
  const commandId = nonEmptyString(input.commandId, "commandId");
  const actorId = nonEmptyString(input.actorId, "actorId");
  const occurredAt = nonEmptyString(input.occurredAt, "occurredAt");
  if (!RFC3339_UTC_PATTERN.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) {
    throw new DomainError(
      "INVALID_FIELD",
      "Event occurredAt must be an RFC3339 UTC timestamp",
      { field: "occurredAt" },
    );
  }
  if (input.data === null || typeof input.data !== "object" || Array.isArray(input.data)) {
    throw new DomainError("INVALID_FIELD", "Event data must be a plain object", {
      field: "data",
    });
  }
  const previousHash = input.previousHash;
  if (previousHash !== null && (typeof previousHash !== "string" || !HASH_PATTERN.test(previousHash))) {
    throw new DomainError(
      "INVALID_FIELD",
      "Event previousHash must be null or a 64-character lowercase hex digest",
      { field: "previousHash" },
    );
  }

  const payload = {
    id,
    sequence: input.sequence,
    aggregateType,
    aggregateId,
    aggregateVersion: input.aggregateVersion,
    type,
    commandId,
    actorId,
    occurredAt,
    data: structuredClone(input.data),
    previousHash,
  };
  const hash = await sha256Hex(canonicalEventPayload(payload));
  return { ...payload, hash };
}

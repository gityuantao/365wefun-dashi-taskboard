import { DomainError } from "../domain/errors.mjs";
import { loadAggregate, upsertAggregateStatement } from "./d1-aggregate-store.mjs";

export async function loadCommandResult(db, commandId) {
  const row = await db
    .prepare(
      "SELECT id, status, result FROM orchestration_commands WHERE id = ?",
    )
    .bind(commandId)
    .first();
  if (!row) return null;
  return {
    commandId: row.id,
    status: row.status,
    result: JSON.parse(row.result),
  };
}

export async function loadEventHead(db, aggregateType, aggregateId) {
  const row = await db
    .prepare(
      `SELECT hash FROM orchestration_events
       WHERE aggregate_type = ? AND aggregate_id = ?
       ORDER BY sequence DESC LIMIT 1`,
    )
    .bind(aggregateType, aggregateId)
    .first();
  return row?.hash ?? null;
}

function commandResult(command, events) {
  return {
    aggregateType: command.aggregateType,
    aggregateId: command.aggregateId,
    version: command.expectedVersion,
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      hash: event.hash,
    })),
  };
}

export async function appendCommandResult(db, { command, events, projection }) {
  const existing = await loadCommandResult(db, command.id);
  if (existing) return existing;

  if (!Array.isArray(events) || events.length === 0) {
    throw new DomainError("INVALID_FIELD", "appendCommandResult requires at least one event");
  }
  if (
    projection === null
    || typeof projection !== "object"
    || Array.isArray(projection)
    || typeof projection.state !== "string"
  ) {
    throw new DomainError(
      "INVALID_FIELD",
      "appendCommandResult requires a projection with a string state",
    );
  }

  const current = await loadAggregate(db, command.aggregateType, command.aggregateId);
  if (current.version !== command.expectedVersion - 1) {
    throw new DomainError("VERSION_CONFLICT", [
      `Aggregate ${command.aggregateType}:${command.aggregateId}`,
      `is at version ${current.version}, command expects version ${command.expectedVersion - 1}`,
    ].join(" "), {
      aggregateType: command.aggregateType,
      aggregateId: command.aggregateId,
      currentVersion: current.version,
      expectedVersion: command.expectedVersion,
    });
  }

  const headHash = await loadEventHead(db, command.aggregateType, command.aggregateId);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.aggregateVersion !== command.expectedVersion + index) {
      throw new DomainError(
        "INVALID_FIELD",
        "Event aggregate versions must continue from the command expected version",
        { expectedVersion: command.expectedVersion, index },
      );
    }
    const requiredPrevious = index === 0 ? headHash : events[index - 1].hash;
    if (event.previousHash !== requiredPrevious) {
      throw new DomainError("HASH_MISMATCH", [
        `Event ${event.id} previousHash does not match the current aggregate head`,
      ].join(" "), {
        aggregateType: command.aggregateType,
        aggregateId: command.aggregateId,
        index,
      });
    }
  }

  const result = commandResult(command, events);
  const statements = [
    db
      .prepare(
        `INSERT INTO orchestration_commands (
          id, type, aggregate_type, aggregate_id, expected_version, actor_id,
          issued_at, reason, parameters, status, result, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        command.id,
        command.type,
        command.aggregateType,
        command.aggregateId,
        command.expectedVersion,
        command.actorId,
        command.issuedAt,
        command.reason,
        JSON.stringify(command.parameters),
        "succeeded",
        JSON.stringify(result),
        command.issuedAt,
        command.issuedAt,
      ),
    ...events.map((event) => db
      .prepare(
        `INSERT INTO orchestration_events (
          id, sequence, aggregate_type, aggregate_id, aggregate_version, type,
          command_id, actor_id, occurred_at, data, previous_hash, hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.id,
        event.sequence,
        event.aggregateType,
        event.aggregateId,
        event.aggregateVersion,
        event.type,
        event.commandId,
        event.actorId,
        event.occurredAt,
        JSON.stringify(event.data),
        event.previousHash,
        event.hash,
      )),
    upsertAggregateStatement(db, {
      aggregateType: command.aggregateType,
      aggregateId: command.aggregateId,
      version: command.expectedVersion,
      state: projection.state,
      snapshot: projection.snapshot ?? null,
      updatedAt: command.issuedAt,
    }),
  ];
  await db.batch(statements);

  return {
    commandId: command.id,
    status: "succeeded",
    result,
  };
}

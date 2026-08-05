import { DomainError } from "../domain/errors.mjs";
import { createDomainEvent } from "../domain/events.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import {
  appendCommandResult,
  loadCommandResult,
  loadEventHead,
} from "../persistence/d1-event-store.mjs";
import { TASK_COMMAND_HANDLERS } from "./task-command-handlers.mjs";
import { VERSION_COMMAND_HANDLERS } from "./version-command-handlers.mjs";

const INITIAL_STATES = { task: "inbox", version: "planning" };
const HANDLERS = { task: TASK_COMMAND_HANDLERS, version: VERSION_COMMAND_HANDLERS };

export async function dispatchCommand({ db, command, now }) {
  const existing = await loadCommandResult(db, command.id);
  if (existing) {
    return {
      commandId: existing.commandId,
      status: existing.status,
      aggregateType: existing.result.aggregateType,
      aggregateId: existing.result.aggregateId,
      version: existing.result.version,
      events: existing.result.events,
    };
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

  const handlers = HANDLERS[command.aggregateType];
  const handler = handlers?.[command.type];
  if (!handler) {
    throw new DomainError(
      "UNSUPPORTED_COMMAND",
      `Command type "${command.type}" is not supported for aggregate "${command.aggregateType}"`,
      { aggregateType: command.aggregateType, type: command.type },
    );
  }

  const currentState = current.state ?? INITIAL_STATES[command.aggregateType];
  const transition = handler(currentState, command.parameters);

  const previousHash = current.version === 0
    ? null
    : await loadEventHead(db, command.aggregateType, command.aggregateId);
  const eventData = {
    from: transition.from,
    to: transition.to,
    ...(command.parameters?.evidenceId ? { evidenceId: command.parameters.evidenceId } : {}),
  };
  const event = await createDomainEvent({
    id: `evt-${command.id}`,
    sequence: command.expectedVersion,
    aggregateType: command.aggregateType,
    aggregateId: command.aggregateId,
    aggregateVersion: command.expectedVersion,
    type: transition.eventType,
    commandId: command.id,
    actorId: command.actorId,
    occurredAt: now,
    data: eventData,
    previousHash,
  });

  const stored = await appendCommandResult(db, {
    command,
    events: [event],
    projection: {
      state: transition.to,
      snapshot: { from: transition.from, to: transition.to },
    },
  });
  return {
    commandId: command.id,
    status: stored.status,
    aggregateType: command.aggregateType,
    aggregateId: command.aggregateId,
    version: command.expectedVersion,
    events: [event],
  };
}

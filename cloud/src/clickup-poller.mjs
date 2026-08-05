import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { createClickUpClient } from "../../orchestration/clickup/client.mjs";
import { loadClickUpConfig } from "../../orchestration/clickup/config-registry.mjs";
import {
  compareSnapshots,
  loadLastConfirmed,
  normalizeTask,
  normalizeVersion,
  saveSnapshot,
} from "../../orchestration/clickup/snapshot.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";

const SUPPORTED_OPERATION_REQUESTS = new Set(["测试通过", "测试不通过"]);

export async function pollClickUpOnce(env, {
  now,
  clientFactory,
} = {}) {
  const effectiveClientFactory = clientFactory ?? env.clientFactory ?? createClickUpClient;
  const config = loadClickUpConfig(JSON.parse(env.CLICKUP_CONFIG));
  const listSet = env.CLICKUP_LIST_SET === "production" ? "production" : "sandbox";
  const taskListKey = listSet === "production" ? "task" : "taskSandbox";
  const versionListKey = listSet === "production" ? "version" : "versionSandbox";
  const client = await effectiveClientFactory({ token: env.CLICKUP_API_TOKEN });
  const commands = [];
  let processed = 0;

  const tasks = await client.getTasksByList(config.lists[taskListKey].id);
  for (const payload of tasks) {
    const snapshot = normalizeTask(payload, config, taskListKey);
    const confirmed = await loadLastConfirmed(env.DB, "task", snapshot.id);
    const changes = compareSnapshots(confirmed, snapshot);
    if (changes.length === 0) continue;
    processed += 1;
    if (snapshot.managed && changes.some((change) => change.field === "operationRequest")) {
      const command = await buildOperationCommand(env, snapshot, now);
      if (command) {
        commands.push(await runCommand(env, command, now));
      }
    }
    await saveSnapshot(env.DB, { type: "task", snapshot, readAt: now });
  }

  const versions = await client.getVersionsByList(config.lists[versionListKey].id);
  for (const payload of versions) {
    const snapshot = normalizeVersion(payload, config, versionListKey);
    const confirmed = await loadLastConfirmed(env.DB, "version", snapshot.id);
    if (compareSnapshots(confirmed, snapshot).length === 0) continue;
    processed += 1;
    await saveSnapshot(env.DB, { type: "version", snapshot, readAt: now });
  }

  return { processed, commands };
}

async function buildOperationCommand(env, snapshot, now) {
  if (!SUPPORTED_OPERATION_REQUESTS.has(snapshot.operationRequest)) return null;
  const aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  const common = {
    id: `poller-${snapshot.id}-${aggregate.version + 1}`,
    aggregateType: "task",
    aggregateId: snapshot.id,
    expectedVersion: aggregate.version + 1,
    actorId: "system-poller",
    issuedAt: now,
    reason: `operation request: ${snapshot.operationRequest}`,
  };
  if (snapshot.operationRequest === "测试通过") {
    return parseCommandEnvelope({ ...common, type: "test_passed", parameters: {} });
  }
  if (snapshot.operationRequest === "测试不通过") {
    return parseCommandEnvelope({
      ...common,
      type: "test_failed",
      parameters: {
        evidenceId: snapshot.operationRequestId ?? `operation-${snapshot.id}`,
      },
    });
  }
  return null;
}

async function runCommand(env, command, now) {
  try {
    const result = await dispatchCommand({ db: env.DB, command, now });
    return {
      id: command.id,
      type: command.type,
      status: result.status,
      aggregateId: command.aggregateId,
    };
  } catch (error) {
    return {
      id: command.id,
      type: command.type,
      status: "failed",
      aggregateId: command.aggregateId,
      error: error.message,
    };
  }
}

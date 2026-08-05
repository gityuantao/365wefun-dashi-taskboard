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
import { enqueueJob } from "../../orchestration/persistence/d1-runner-jobs.mjs";
import { loadCommandResult } from "../../orchestration/persistence/d1-event-store.mjs";
import { enqueueMutation } from "../../orchestration/clickup/outbox.mjs";

const SUPPORTED_OPERATION_REQUESTS = new Set(["测试通过", "测试不通过"]);

function jobTypeForState(status) {
  if (status === "inbox") return "analyze";
  if (status === "analyzing") return "analyze";
  if (status === "ready_for_development") return "develop";
  if (status === "developing") return "develop";
  if (status === "ready_for_acceptance") return "accept";
  if (status === "accepting") return "accept";
  return null;
}

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

async function ensureStateJob(env, snapshot, now) {
  const aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  const jobType = jobTypeForState(aggregate.state ?? snapshot.status);
  if (!jobType) return;
  const jobId = `${snapshot.id}-${jobType}-${aggregate.version}`;
  const existing = await env.DB
    .prepare("SELECT status, completed_at FROM runner_jobs WHERE id = ?")
    .bind(jobId)
    .first();
  if (existing && (existing.status === "queued" || existing.status === "claimed")) return;
  const retryWindowMinutes = Number(env.CLICKUP_JOB_RETRY_MINUTES ?? 5);
  if (
    existing?.status === "failed"
    && existing.completed_at
    && existing.completed_at > addMinutes(now, -retryWindowMinutes)
  ) {
    return;
  }
  if (existing) {
    await env.DB.prepare("DELETE FROM runner_jobs WHERE id = ?").bind(jobId).run();
  }
  await enqueueJob(env.DB, {
    jobId,
    commandId: `auto-${jobType}-${snapshot.id}`,
    jobType,
    payload: {
      taskId: snapshot.id,
      repoPath: env.CLICKUP_REPO_PATH,
      worktreesRoot: env.CLICKUP_WORKTREES_ROOT,
      baseRef: env.CLICKUP_BASE_REF ?? "main",
      versionBranch: snapshot.targetVersion
        ? `version/${snapshot.targetVersion}`
        : undefined,
      acceptanceCriteria: [],
    },
    payloadHash: snapshot.fieldsHash,
    expiresAt: addMinutes(now, 15),
    createdAt: now,
  });
}

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
    if (changes.length === 0) {
      if (snapshot.managed) {
        await handleOperationRequest(env, snapshot, now, commands, config);
        await ensureStateJob(env, snapshot, now);
      }
      continue;
    }
    processed += 1;
    await handleOperationRequest(env, snapshot, now, commands, config);
    if (snapshot.managed) {
      let aggregate = await loadAggregate(env.DB, "task", snapshot.id);
      if (snapshot.status === "inbox" && aggregate.version === 0) {
        const started = await runCommand(env, parseCommandEnvelope({
          id: `poller-start-analysis-${snapshot.id}`,
          type: "start_analysis",
          aggregateType: "task",
          aggregateId: snapshot.id,
          expectedVersion: 1,
          actorId: "system-poller",
          issuedAt: now,
          reason: "task admitted to automation",
          parameters: {},
        }), now, config);
        commands.push(started);
        aggregate = await loadAggregate(env.DB, "task", snapshot.id);
      }
      await ensureStateJob(env, snapshot, now);
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

async function handleOperationRequest(env, snapshot, now, commands, config) {
  if (!snapshot.managed || !SUPPORTED_OPERATION_REQUESTS.has(snapshot.operationRequest)) {
    return;
  }
  let aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  if (["测试通过", "测试不通过"].includes(snapshot.operationRequest)) {
    if (aggregate.state === "ready_for_test") {
      const startTestId = `poller-start-test-${snapshot.id}-${aggregate.version + 1}`;
      if (!(await loadCommandResult(env.DB, startTestId))) {
        const startTest = parseCommandEnvelope({
          id: startTestId,
          type: "start_test",
          aggregateType: "task",
          aggregateId: snapshot.id,
          expectedVersion: aggregate.version + 1,
          actorId: "system-poller",
          issuedAt: now,
          reason: "test started by operation request",
          parameters: {},
        });
        commands.push(await runCommand(env, startTest, now, config));
      }
      aggregate = await loadAggregate(env.DB, "task", snapshot.id);
    }
    if (aggregate.state !== "testing") return;
  }
  const operationCommand = await buildOperationCommand(
    env,
    snapshot,
    now,
    aggregate.version + 1,
  );
  if (operationCommand && !(await loadCommandResult(env.DB, operationCommand.id))) {
    commands.push(await runCommand(env, operationCommand, now, config));
  }
}

async function buildOperationCommand(env, snapshot, now, expectedVersion) {
  if (!SUPPORTED_OPERATION_REQUESTS.has(snapshot.operationRequest)) return null;
  const common = {
    id: `poller-${snapshot.id}-${expectedVersion}`,
    aggregateType: "task",
    aggregateId: snapshot.id,
    expectedVersion,
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

function clickupStatusName(config, aggregateType, canonical) {
  const map = aggregateType === "version" ? config.versionStatusMap : config.taskStatusMap;
  return Object.entries(map).find(([, value]) => value === canonical)?.[0] ?? null;
}

async function runCommand(env, command, now, config) {
  try {
    const result = await dispatchCommand({ db: env.DB, command, now });
    const outcome = {
      id: command.id,
      type: command.type,
      status: result.status,
      aggregateId: command.aggregateId,
    };
    const event = result.events?.[0];
    if (result.status === "succeeded" && event?.data?.to && config) {
      const clickupStatus = clickupStatusName(config, command.aggregateType, event.data.to);
      if (clickupStatus) {
        await enqueueMutation(env.DB, {
          mutationId: `outbox-${command.id}`,
          objectType: command.aggregateType,
          objectId: command.aggregateId,
          field: "status",
          expectedBefore: event.data.from ?? null,
          target: clickupStatus,
          actor: "system-poller",
          expiresAt: addMinutes(now, 10),
          createdAt: now,
        });
      }
    }
    return outcome;
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

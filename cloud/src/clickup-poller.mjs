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
import {
  checkTaskVersionGate,
  resolveCurrentDevVersionName,
} from "../../orchestration/application/version-gate.mjs";

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

async function resumeAnalysisAfterInfo(env, snapshot, now, commands, config) {
  // 清除 needs_human 失败记录，恢复分析后允许重新入队
  await env.DB
    .prepare(
      "DELETE FROM runner_jobs WHERE command_id = ? AND status = 'failed' AND result LIKE '%needs_human%'",
    )
    .bind(`auto-analyze-${snapshot.id}`)
    .run();
  const aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  const commandId = `poller-resume-analysis-${snapshot.id}-${aggregate.version + 1}`;
  if (await loadCommandResult(env.DB, commandId)) return;
  const command = parseCommandEnvelope({
    id: commandId,
    type: "analysis_restarted",
    aggregateType: "task",
    aggregateId: snapshot.id,
    expectedVersion: aggregate.version + 1,
    actorId: "system-poller",
    issuedAt: now,
    reason: "task status changed back from waiting_info",
    parameters: {},
  });
  commands.push(await runCommand(env, command, now, config));
}

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

async function ensureStateJob(env, snapshot, now, currentDevVersion) {
  const aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  const jobType = jobTypeForState(aggregate.state ?? snapshot.status);
  if (!jobType) return;
  const jobId = `${snapshot.id}-${jobType}-${aggregate.version}`;
  const existing = await env.DB
    .prepare("SELECT status, completed_at, result FROM runner_jobs WHERE id = ?")
    .bind(jobId)
    .first();

  // 版本门禁：非当前开发版本的任务不派发任何作业。
  // 无版本任务放行，让分析阶段先分配版本。
  const gate = checkTaskVersionGate({
    targetVersion: snapshot.targetVersion,
    currentDevVersion,
  });
  if (gate.blocked) {
    // 保留 waiting_version 失败记录，解禁后由下方逻辑立即重新入队
    return;
  }

  if (existing?.status === "failed" && existing.result?.includes("waiting_version")) {
    // 版本已轮到当前：删除旧的等待作业，立即重新入队
    await env.DB.prepare("DELETE FROM runner_jobs WHERE id = ?").bind(jobId).run();
  } else {
    const active = await env.DB
      .prepare(
        "SELECT id FROM runner_jobs WHERE command_id = ? AND status IN ('queued', 'claimed')",
      )
      .bind(`auto-${jobType}-${snapshot.id}`)
      .first();
    if (active) return;
    if (existing && (existing.status === "queued" || existing.status === "claimed")) return;
    if (existing?.status === "failed" && existing.result?.includes("needs_human")) {
      return;
    }
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

  const versions = await client.getVersionsByList(config.lists[versionListKey].id);
  const currentDevVersion = resolveCurrentDevVersionName(versions);

  const tasks = await client.getTasksByList(config.lists[taskListKey].id);
  for (const payload of tasks) {
    const snapshot = normalizeTask(payload, config, taskListKey);
    const confirmed = await loadLastConfirmed(env.DB, "task", snapshot.id);
    const changes = compareSnapshots(confirmed, snapshot);

    // 版本门禁：非当前开发版本的任务不做任何操作（分析/开发/测试/验收均不允许）
    const gate = checkTaskVersionGate({
      targetVersion: snapshot.targetVersion,
      currentDevVersion,
    });
    if (gate.blocked) {
      if (changes.length > 0) {
        processed += 1;
        await saveSnapshot(env.DB, { type: "task", snapshot, readAt: now });
      }
      continue;
    }

    if (changes.length === 0) {
      await handleOperationRequest(env, snapshot, now, commands, config);
      await ensureStateJob(env, snapshot, now, currentDevVersion);
      continue;
    }
    processed += 1;
    let aggregate = await loadAggregate(env.DB, "task", snapshot.id);
    // 等待补充信息的任务：用户回复并把状态改回「分析中」后，自动恢复分析
    if (aggregate.state === "waiting_info" && snapshot.status !== "waiting_info") {
      await resumeAnalysisAfterInfo(env, snapshot, now, commands, config);
      aggregate = await loadAggregate(env.DB, "task", snapshot.id);
    }
    if (changes.some((change) => change.field === "updatedAt")) {
      await env.DB
        .prepare(
          "DELETE FROM runner_jobs WHERE command_id = ? AND status = 'failed' AND result LIKE '%needs_human%'",
        )
        .bind(`auto-analyze-${snapshot.id}`)
        .run();
    }
    await handleOperationRequest(env, snapshot, now, commands, config);
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
    await ensureStateJob(env, snapshot, now, currentDevVersion);
    await saveSnapshot(env.DB, { type: "task", snapshot, readAt: now });
  }

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
  if (!SUPPORTED_OPERATION_REQUESTS.has(snapshot.operationRequest)) {
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

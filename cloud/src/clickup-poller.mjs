import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import path from "node:path";
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
import { stateChangeText } from "../../orchestration/clickup/state-comments.mjs";

function jobTypeForState(status) {
  if (status === "inbox") return "analyze";
  if (status === "analyzing") return "analyze";
  if (status === "ready_for_development") return "develop";
  if (status === "developing") return "develop";
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

async function resumeDevelopmentAfterInfo(env, snapshot, now, commands, config) {
  // 清除 needs_info 失败记录，恢复开发后允许重新入队
  await env.DB
    .prepare(
      "DELETE FROM runner_jobs WHERE command_id = ? AND status = 'failed' AND result LIKE '%needs_info%'",
    )
    .bind(`auto-develop-${snapshot.id}`)
    .run();
  const aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  const commandId = `poller-resume-development-${snapshot.id}-${aggregate.version + 1}`;
  if (await loadCommandResult(env.DB, commandId)) return;
  const command = parseCommandEnvelope({
    id: commandId,
    type: "development_restarted",
    aggregateType: "task",
    aggregateId: snapshot.id,
    expectedVersion: aggregate.version + 1,
    actorId: "system-poller",
    issuedAt: now,
    reason: "task status changed back to developing after waiting for info",
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
  if (jobType === "develop") {
    const paused = await env.DB.prepare("SELECT id FROM runner_jobs WHERE id = ?").bind("acceptance-paused-" + snapshot.id).first();
    if (paused) return;
  }
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
    if (existing?.status === "failed" && existing.result?.includes("needs_info")) {
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

  // 验收作业需要分析阶段的验收标准
  let acceptanceCriteria = [];
  if (jobType === "accept") {
    const analysisRows = await env.DB
      .prepare(
        "SELECT result FROM runner_jobs WHERE id LIKE ? AND job_type = 'analyze' AND status = 'completed' ORDER BY completed_at DESC LIMIT 1",
      )
      .bind(`${snapshot.id}-analyze-%`)
      .all();
    const analysis = analysisRows.results[0];
    if (analysis) {
      try {
        acceptanceCriteria = JSON.parse(analysis.result)?.summary?.acceptance_criteria ?? [];
      } catch {
        // 分析结果解析失败时按无验收标准处理
      }
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
      // 分析阶段只读，不需要任务工作区；开发/验收在任务工作区内执行
      workdir: jobType === "develop" || jobType === "accept"
        ? (env.CLICKUP_WORKTREES_ROOT
            ? path.join(env.CLICKUP_WORKTREES_ROOT, `task-${snapshot.id}`)
            : undefined)
        : undefined,
      acceptanceCriteria,
    },
    payloadHash: snapshot.fieldsHash,
    expiresAt: addMinutes(now, 90),
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
      await handleStatusDrivenFlow(env, snapshot, now, commands, config);
      await ensureInboxAnalysis(env, snapshot, now, commands, config);
      await ensureStateJob(env, snapshot, now, currentDevVersion);
      continue;
    }
    processed += 1;
    let aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  if (aggregate.state === "ready_for_development" && snapshot.status === "developing") {
    await env.DB.prepare("DELETE FROM runner_jobs WHERE id = ?").bind("acceptance-paused-" + snapshot.id).run();
    const startId = "poller-start-dev-" + snapshot.id + "-" + (aggregate.version + 1);
    if (!(await loadCommandResult(env.DB, startId))) {
      const start = parseCommandEnvelope({
        id: startId,
        type: "start_development",
        aggregateType: "task",
        aggregateId: snapshot.id,
        expectedVersion: aggregate.version + 1,
        actorId: "system-poller",
        issuedAt: now,
        reason: "user moved task to 开发中",
        parameters: {},
      });
      commands.push(await runCommand(env, start, now, config));
    }
    aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  }

    // 等待补充信息的任务：用户回复并把状态改回「分析中/开发中」后，自动恢复
    if (aggregate.state === "waiting_info" && snapshot.status !== "waiting_info") {
      if (snapshot.status === "analyzing") {
        await resumeAnalysisAfterInfo(env, snapshot, now, commands, config);
      } else if (snapshot.status === "developing") {
        await resumeDevelopmentAfterInfo(env, snapshot, now, commands, config);
      }
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
    await handleStatusDrivenFlow(env, snapshot, now, commands, config);
    await ensureInboxAnalysis(env, snapshot, now, commands, config);
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

/**
 * 状态驱动流程：不再依赖「操作请求」字段。
 * 用户在 ClickUp 里把任务从「待测试」拖到「待发布」= 测试通过；
 * 拖回「待开发」= 测试不通过（退回返工）。系统看到状态变化即推进。
 */
// 收件箱任务首次进入自动化：初始化聚合（inbox -> analyzing），
// 无论快照是否有变化都应执行，否则分析完成时没有聚合可推进。
async function ensureInboxAnalysis(env, snapshot, now, commands, config) {
  if (snapshot.status !== "inbox") return;
  const aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  if (aggregate.version !== 0) return;
  const commandId = `poller-start-analysis-${snapshot.id}`;
  if (await loadCommandResult(env.DB, commandId)) return;
  const started = await runCommand(env, parseCommandEnvelope({
    id: commandId,
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
}

async function handleStatusDrivenFlow(env, snapshot, now, commands, config) {

  let aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  if (aggregate.state === "ready_for_development" && snapshot.status === "developing") {
    await env.DB.prepare("DELETE FROM runner_jobs WHERE id = ?").bind("acceptance-paused-" + snapshot.id).run();
    const startId = "poller-start-dev-" + snapshot.id + "-" + (aggregate.version + 1);
    if (!(await loadCommandResult(env.DB, startId))) {
      const start = parseCommandEnvelope({
        id: startId,
        type: "start_development",
        aggregateType: "task",
        aggregateId: snapshot.id,
        expectedVersion: aggregate.version + 1,
        actorId: "system-poller",
        issuedAt: now,
        reason: "user moved task to 开发中",
        parameters: {},
      });
      commands.push(await runCommand(env, start, now, config));
    }
    aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  }

  // 验收不通过：用户处理完原因后手动改回「待开发」（重新开发）或「待测试」（直接测试）
  if (aggregate.state === "acceptance_rejected" && snapshot.status === "ready_for_development") {
    const devId = "poller-rejected-to-dev-" + snapshot.id + "-" + (aggregate.version + 1);
    if (!(await loadCommandResult(env.DB, devId))) {
      commands.push(await runCommand(env, parseCommandEnvelope({
        id: devId,
        type: "acceptance_rejected_to_develop",
        aggregateType: "task",
        aggregateId: snapshot.id,
        expectedVersion: aggregate.version + 1,
        actorId: "system-poller",
        issuedAt: now,
        reason: "user routed rejected task back to rework",
        parameters: {},
      }), now, config));
    }
    aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  }
  if (aggregate.state === "acceptance_rejected" && snapshot.status === "ready_for_test") {
    const testId = "poller-rejected-to-test-" + snapshot.id + "-" + (aggregate.version + 1);
    if (!(await loadCommandResult(env.DB, testId))) {
      commands.push(await runCommand(env, parseCommandEnvelope({
        id: testId,
        type: "acceptance_rejected_to_test",
        aggregateType: "task",
        aggregateId: snapshot.id,
        expectedVersion: aggregate.version + 1,
        actorId: "system-poller",
        issuedAt: now,
        reason: "user routed rejected task to testing",
        parameters: {},
      }), now, config));
    }
    aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  }

  if (aggregate.state === "ready_for_test" && snapshot.status === "ready_for_release") {
    const resultId = "poller-" + snapshot.id + "-" + (aggregate.version + 1);
    if (!(await loadCommandResult(env.DB, resultId))) {
      commands.push(await runCommand(env, parseCommandEnvelope({
        id: resultId,
        type: "test_passed",
        aggregateType: "task",
        aggregateId: snapshot.id,
        expectedVersion: aggregate.version + 1,
        actorId: "system-poller",
        issuedAt: now,
        reason: "user moved task to 待发布",
        parameters: {},
      }), now, config));
    }
    aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  } else if (aggregate.state === "ready_for_test" && snapshot.status === "ready_for_development") {
    const resultId = "poller-" + snapshot.id + "-" + (aggregate.version + 1);
    if (!(await loadCommandResult(env.DB, resultId))) {
      commands.push(await runCommand(env, parseCommandEnvelope({
        id: resultId,
        type: "test_failed",
        aggregateType: "task",
        aggregateId: snapshot.id,
        expectedVersion: aggregate.version + 1,
        actorId: "system-poller",
        issuedAt: now,
        reason: "user moved task back to 待开发",
        parameters: { evidenceId: "operation-" + snapshot.id },
      }), now, config));
    }
    aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  } else if (aggregate.state === "ready_for_test" && snapshot.status === "testing") {
    const startTestId = "poller-start-test-" + snapshot.id + "-" + (aggregate.version + 1);
    if (!(await loadCommandResult(env.DB, startTestId))) {
      const startTest = parseCommandEnvelope({
        id: startTestId,
        type: "start_test",
        aggregateType: "task",
        aggregateId: snapshot.id,
        expectedVersion: aggregate.version + 1,
        actorId: "system-poller",
        issuedAt: now,
        reason: "user moved task to 测试中",
        parameters: {},
      });
      commands.push(await runCommand(env, startTest, now, config));
    }
    aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  }
    if (aggregate.state !== "testing") return;
  const expectedVersion = aggregate.version + 1;
  let type = null;
  let reason = null;
  if (snapshot.status === "ready_for_release") {
    type = "test_passed";
    reason = "status moved to 待发布";
  } else if (snapshot.status === "ready_for_development") {
    type = "test_failed";
    reason = "status moved back to 待开发";
  }
  if (!type) return;
  const common = {
    id: `poller-${snapshot.id}-${expectedVersion}`,
    aggregateType: "task",
    aggregateId: snapshot.id,
    expectedVersion,
    actorId: "system-poller",
    issuedAt: now,
    reason,
  };
  const parameters = type === "test_failed"
    ? { evidenceId: `operation-${snapshot.id}` }
    : {};
  const command = parseCommandEnvelope({ ...common, type, parameters });
  if (!(await loadCommandResult(env.DB, command.id))) {
    commands.push(await runCommand(env, command, now, config));
  }
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
      const comment = stateChangeText(command.aggregateType, event.data.from, event.data.to);
      if (comment) {
        try {
          const factory = env.clientFactory ?? createClickUpClient;
          const client = await factory({ token: env.CLICKUP_API_TOKEN });
          await client.postComment(command.aggregateId, comment);
        } catch {
          // 评论失败不影响状态推进
        }
      }
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

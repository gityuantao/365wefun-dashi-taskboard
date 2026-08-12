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
import {
  inferPlatformsFromText,
  normalizePlatforms,
} from "../../orchestration/domain/platforms.mjs";
import { resolveSatisfiedReworkBlockers } from "../../orchestration/application/blocker-reconciliation.mjs";

function jobTypeForState(status) {
  if (status === "inbox") return "analyze";
  if (status === "analyzing") return "analyze";
  if (status === "ready_for_development") return "develop";
  if (status === "developing") return "develop";
  if (status === "accepting") return "accept";
  return null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" && value !== "unknown";
}

function matchesStagingAttempt(payload, attempt, taskId) {
  return payload?.taskId === taskId
    && nonEmptyString(payload?.pr?.url)
    && payload.pr.url === attempt.pr_url
    && nonEmptyString(payload.commitSha)
    && payload.commitSha === attempt.task_commit
    && nonEmptyString(payload.versionBranch)
    && payload.versionBranch === attempt.version_branch
    && nonEmptyString(payload.targetVersion)
    && payload.targetVersion === attempt.target_version
    && Object.hasOwn(payload, "platforms")
    && Array.isArray(payload.platforms)
    && payload.platforms.every(nonEmptyString);
}

async function loadStagingRecovery(db, taskId) {
  const rejectionRows = await db.prepare(
    `SELECT actor_id, occurred_at, json_extract(data, '$.evidenceId') AS evidence_id
     FROM orchestration_events
     WHERE aggregate_type = 'task' AND aggregate_id = ?
       AND type = 'task.acceptance_rejected'
     ORDER BY aggregate_version DESC LIMIT 2`,
  ).bind(taskId).all();
  const [rejection, previousRejection] = rejectionRows.results ?? [];
  const productRejection = rejection?.actor_id === "runner-acceptor"
    && typeof rejection.evidence_id === "string"
    && rejection.evidence_id.startsWith("acceptance-");
  if (productRejection) return { kind: "product_rework" };
  const stagingRejection = rejection?.actor_id === "runner-staging"
    && typeof rejection.evidence_id === "string"
    && rejection.evidence_id.startsWith("staging-");
  if (!stagingRejection) {
    return { kind: "blocked", reason: "rejection ownership cannot be proven" };
  }
  const stageJobId = rejection.evidence_id.slice("staging-".length);
  if (!nonEmptyString(stageJobId)) {
    return { kind: "blocked", reason: "staging rejection evidence does not name a stage job" };
  }
  const attempt = await db.prepare(
    `SELECT status, completed_at, failure_owner, pr_url, task_commit, version_branch, target_version
     FROM staging_deployments WHERE task_id = ? ORDER BY attempt DESC LIMIT 1`,
  ).bind(taskId).first();
  if (!attempt || attempt.status === "succeeded") {
    return { kind: "blocked", reason: "rejection ownership cannot be proven" };
  }
  if (attempt.status !== "failed") {
    return { kind: "blocked", reason: `latest staging attempt is ${attempt.status}` };
  }
  if (
    attempt.failure_owner === "product_rework"
    && nonEmptyString(attempt.completed_at)
    && attempt.completed_at <= rejection.occurred_at
    && (!previousRejection?.occurred_at || attempt.completed_at > previousRejection.occurred_at)
  ) {
    return { kind: "product_rework" };
  }
  if (attempt.failure_owner !== "staging_infrastructure") {
    return {
      kind: "blocked",
      reason: "latest staging failure owner is unknown; current staging failure ownership cannot be proven",
    };
  }
  if (
    !nonEmptyString(attempt.completed_at)
    || attempt.completed_at > rejection.occurred_at
    || (
      previousRejection?.occurred_at
      && attempt.completed_at <= previousRejection.occurred_at
    )
  ) {
    return { kind: "blocked", reason: "staging failure does not match the current rejection" };
  }
  const stageJob = await db.prepare(
    `SELECT job_type, status, result, payload FROM runner_jobs WHERE id = ? LIMIT 1`,
  ).bind(stageJobId).first();
  if (!stageJob || stageJob.job_type !== "stage_task" || stageJob.status !== "failed") {
    return { kind: "blocked", reason: "exact failed stage task evidence is absent" };
  }
  let payload;
  let result;
  try {
    payload = JSON.parse(stageJob.payload);
    result = JSON.parse(stageJob.result);
  } catch {
    return { kind: "blocked", reason: "exact stage task evidence is malformed" };
  }
  if (
    result?.status !== "failed"
    || result?.classification !== "staging_infrastructure"
  ) {
    return { kind: "blocked", reason: "exact stage task result is not a staging infrastructure failure" };
  }
  if (!matchesStagingAttempt(payload, attempt, taskId)) {
    return { kind: "blocked", reason: "exact stage task payload does not match the current staging attempt" };
  }
  return {
    kind: "staging_infrastructure",
    payload: {
      taskId,
      pr: { url: payload.pr.url },
      commitSha: payload.commitSha,
      versionBranch: payload.versionBranch,
      targetVersion: payload.targetVersion,
      platforms: [...payload.platforms],
    },
  };
}

async function postStagingRecoveryBlocked(env, taskId, reason) {
  try {
    const factory = env.clientFactory ?? createClickUpClient;
    const client = await factory({ token: env.CLICKUP_API_TOKEN });
    await client.postComment(taskId, [
      "⚠️ 无法恢复测试环境部署",
      "恢复证据不完整，编排状态保持「验收不通过」，未创建任何作业。",
      "修复证据后，请先把 ClickUp 状态移回「验收不通过」，再改为「待开发」重新触发。",
      `原因：${reason}`,
    ].join("\n"));
  } catch {
    // 评论失败不改变 fail-closed 行为。
  }
}

async function resumeAnalysisAfterInfo(env, snapshot, now, commands, config) {
  // 清除 needs_human 失败记录，恢复分析后允许重新入队
  await env.DB
    .prepare(
      `DELETE FROM runner_jobs
       WHERE command_id = ? AND status = 'failed'
         AND json_extract(result, '$.classification') IN ('needs_human', 'paused_waiting_info')`,
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
      `DELETE FROM runner_jobs
       WHERE command_id = ? AND status = 'failed'
         AND json_extract(result, '$.classification') IN ('needs_info', 'paused_waiting_info')`,
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

async function clearOrdinaryDevelopmentFailures(db, taskId) {
  await db
    .prepare(
      `DELETE FROM runner_jobs
       WHERE command_id = ? AND status = 'failed'
         AND COALESCE(result, '') NOT LIKE '%waiting_version%'
         AND COALESCE(result, '') NOT LIKE '%waiting:%'
         AND COALESCE(result, '') NOT LIKE '%needs_human%'
         AND COALESCE(result, '') NOT LIKE '%needs_info%'
         AND COALESCE(json_extract(result, '$.classification'), '') <> 'invalid_context'`,
    )
    .bind(`auto-develop-${taskId}`)
    .run();
}

async function loadAnalysisCriteria(db, taskId) {
  const row = await db
    .prepare(
      `SELECT result FROM runner_jobs
       WHERE job_type = 'analyze' AND status = 'completed'
         AND json_extract(payload, '$.taskId') = ?
       ORDER BY completed_at DESC, created_at DESC LIMIT 1`,
    )
    .bind(taskId)
    .first();
  if (!row?.result) {
    return { error: `no completed analysis found for exact task ${taskId}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(row.result);
  } catch {
    return { error: `latest completed analysis result is malformed for exact task ${taskId}` };
  }
  const criteria = parsed?.summary?.acceptance_criteria;
  if (
    !Array.isArray(criteria)
    || criteria.length === 0
    || criteria.some((criterion) => (
      !criterion
      || typeof criterion !== "object"
      || !nonEmptyString(criterion.id)
      || !nonEmptyString(criterion.criterion)
    ))
  ) {
    return { error: `latest completed analysis has no usable acceptance criteria for exact task ${taskId}` };
  }
  const storedPlatforms = normalizePlatforms(parsed?.platforms);
  const platforms = storedPlatforms.length > 0
    ? storedPlatforms
    : inferPlatformsFromText([
        parsed?.summary?.scope,
        ...criteria.map((criterion) => criterion.criterion),
      ].filter(Boolean).join("\n"));
  return { criteria, platforms };
}

async function loadCurrentReworkFindings(db, taskId) {
  const source = await db
    .prepare(
      `SELECT type, aggregate_version, command_id, actor_id, data
       FROM orchestration_events
       WHERE aggregate_type = 'task' AND aggregate_id = ?
         AND type IN (
           'task.analysis_completed',
           'task.acceptance_failed',
           'task.acceptance_rejected_to_develop',
           'task.development_failed',
           'task.test_failed'
         )
       ORDER BY aggregate_version DESC LIMIT 1`,
    )
    .bind(taskId)
    .first();
  if (!source || !new Set([
    "task.acceptance_failed",
    "task.acceptance_rejected_to_develop",
  ]).has(source.type)) {
    return { findings: [] };
  }
  let rejection = source;
  if (source.type === "task.acceptance_rejected_to_develop") {
    rejection = await db
      .prepare(
        `SELECT type, aggregate_version, command_id, actor_id, data
         FROM orchestration_events
         WHERE aggregate_type = 'task' AND aggregate_id = ?
           AND aggregate_version = ? AND type = 'task.acceptance_rejected'
         LIMIT 1`,
      )
      .bind(taskId, source.aggregate_version - 1)
      .first();
    if (!rejection) {
      return { error: `current rework has no preceding acceptance rejection for exact task ${taskId}` };
    }
  }
  let eventData;
  try {
    eventData = JSON.parse(rejection.data);
  } catch {
    return { error: `current acceptance rejection evidence is malformed for exact task ${taskId}` };
  }
  const evidenceId = eventData?.evidenceId;
  if (!nonEmptyString(evidenceId)) {
    return { error: `current acceptance rejection evidence is invalid for exact task ${taskId}` };
  }
  const acceptanceEvidence = rejection.actor_id === "runner-acceptor"
    && evidenceId.startsWith("acceptance-")
    && rejection.command_id === evidenceId;
  const stagingEvidence = rejection.actor_id === "runner-staging"
    && evidenceId.startsWith("staging-");
  if (!acceptanceEvidence && !stagingEvidence) {
    return { error: `current acceptance rejection evidence is invalid for exact task ${taskId}` };
  }
  const jobId = evidenceId.slice(
    acceptanceEvidence ? "acceptance-".length : "staging-".length,
  );
  const row = await db
    .prepare(
      `SELECT job_type, status, payload, result FROM runner_jobs
       WHERE id = ? LIMIT 1`,
    )
    .bind(jobId)
    .first();
  if (!row) {
    return {
      error: acceptanceEvidence
        ? `exact acceptance job ${jobId} is missing for task ${taskId}`
        : `exact staging job ${jobId} is missing for task ${taskId}`,
    };
  }
  if (stagingEvidence) {
    if (row.job_type !== "stage_task" || row.status !== "failed") {
      return { error: `exact staging job ${jobId} is not a failed stage job for task ${taskId}` };
    }
    let payload;
    let parsed;
    try {
      payload = JSON.parse(row.payload);
      parsed = JSON.parse(row.result);
    } catch {
      return { error: `exact staging job ${jobId} is malformed for task ${taskId}` };
    }
    const mergeConflict = parsed?.classification === "merge_conflict"
      && Array.isArray(parsed.conflictedPaths)
      && parsed.conflictedPaths.length > 0
      && parsed.conflictedPaths.every((value) => nonEmptyString(value));
    const staleAcceptance = parsed?.classification === "stale_acceptance"
      && nonEmptyString(parsed?.error);
    if (
      payload?.taskId !== taskId
      || parsed?.status !== "failed"
      || parsed?.stage !== "merge"
      || !nonEmptyString(payload?.pr?.url)
      || !nonEmptyString(payload?.versionBranch)
      || (!mergeConflict && !staleAcceptance)
    ) {
      return { error: `exact staging job ${jobId} does not contain valid product-rework evidence for task ${taskId}` };
    }
    return {
      findings: [{
        classification: parsed.classification,
        stage: "merge",
        prUrl: payload.pr.url,
        versionBranch: payload.versionBranch,
        ...(mergeConflict ? { conflictedPaths: [...parsed.conflictedPaths] } : {}),
        description: String(parsed.error ?? "staging product rework is required"),
        requiredAction: mergeConflict
          ? "merge the latest version branch, resolve these conflicts, and update the original PR"
          : "verify the current original PR head and produce fresh acceptance evidence for that exact commit",
      }],
    };
  }
  if (row.job_type !== "accept" || row.status !== "completed") {
    return { error: `exact acceptance job ${jobId} is not a completed accept job for task ${taskId}` };
  }
  let payload;
  let parsed;
  try {
    payload = JSON.parse(row.payload);
    parsed = JSON.parse(row.result);
  } catch {
    return { error: `exact acceptance job ${jobId} is malformed for task ${taskId}` };
  }
  if (
    payload?.taskId !== taskId
    || parsed?.status !== "completed"
    || parsed?.result !== "rejected"
    || !Array.isArray(parsed.findings)
  ) {
    return { error: `exact acceptance job ${jobId} does not match current rejection for task ${taskId}` };
  }
  return { findings: parsed.findings };
}

async function reconcileManualWaitingInfo(env, snapshot, now, commands, config) {
  if (snapshot.status !== "waiting_info") return;
  const aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  const commandType = {
    analyzing: "analysis_needs_human",
    ready_for_development: "manual_pause_for_info",
    developing: "development_needs_info",
    accepting: "manual_pause_for_info",
    ready_for_test: "manual_pause_for_info",
  }[aggregate.state];
  if (commandType) {
    const commandId = `poller-manual-pause-${snapshot.id}-${aggregate.version + 1}`;
    if (!(await loadCommandResult(env.DB, commandId))) {
      commands.push(await runCommand(env, parseCommandEnvelope({
        id: commandId,
        type: commandType,
        aggregateType: "task",
        aggregateId: snapshot.id,
        expectedVersion: aggregate.version + 1,
        actorId: "system-poller",
        issuedAt: now,
        reason: "user moved task to waiting_info",
        parameters: {},
      }), now, config));
    }
  }

  // Queued work has not started and is safe to remove. Claimed work remains leased;
  // executors cooperatively stop when the aggregate state/version changes.
  await env.DB
    .prepare(
      `DELETE FROM runner_jobs
       WHERE status = 'queued' AND json_extract(payload, '$.taskId') = ?`,
    )
    .bind(snapshot.id)
    .run();

  const waitingStatus = clickupStatusName(config, "task", "waiting_info");
  await env.DB
    .prepare(
      `UPDATE outbox_mutations SET status = 'expired'
       WHERE object_type = 'task' AND object_id = ? AND field = 'status'
         AND status = 'pending' AND target <> ?`,
    )
    .bind(snapshot.id, JSON.stringify(waitingStatus))
    .run();
}

async function reconcileManualTestPassed(env, snapshot, now, commands, config) {
  if (snapshot.status !== "ready_for_release") return;
  const aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  if (aggregate.state !== "ready_for_test") return;
  const resultId = "poller-" + snapshot.id + "-" + (aggregate.version + 1);
  if (await loadCommandResult(env.DB, resultId)) return;
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

async function ensureStateJob(env, snapshot, now, currentDevVersion) {
  const aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  let jobType = jobTypeForState(aggregate.state ?? snapshot.status);
  let acceptedResult = null;
  let stagingRecoveryPayload = null;
  if (aggregate.state === "accepting") {
    const latestEvent = await env.DB.prepare(
      `SELECT type FROM orchestration_events
       WHERE aggregate_type = 'task' AND aggregate_id = ?
       ORDER BY aggregate_version DESC LIMIT 1`,
    ).bind(snapshot.id).first();
    if (latestEvent?.type === "task.staging_retried") {
      const recovery = await loadStagingRecovery(env.DB, snapshot.id);
      if (recovery.kind !== "staging_infrastructure") return;
      stagingRecoveryPayload = recovery.payload;
      jobType = "stage_task";
    }
    const accepted = await env.DB
      .prepare(
        `SELECT result FROM runner_jobs
         WHERE job_type = 'accept' AND status = 'completed'
           AND json_extract(payload, '$.taskId') = ?
           AND json_extract(payload, '$.aggregateVersion') = ?
           AND json_extract(result, '$.result') = 'accepted'
         ORDER BY completed_at DESC LIMIT 1`,
      )
      .bind(snapshot.id, aggregate.version)
      .first();
    if (!stagingRecoveryPayload && accepted?.result) {
      acceptedResult = JSON.parse(accepted.result);
      jobType = "stage_task";
    }
  }
  if (!jobType) return;
  if (jobType === "develop") {
    const paused = await env.DB.prepare("SELECT id FROM runner_jobs WHERE id = ?").bind("acceptance-paused-" + snapshot.id).first();
    if (paused) return;
  }
  if (jobType === "develop" || jobType === "accept" || jobType === "stage_task") {
    const invalidContext = await env.DB
      .prepare(
        `SELECT id FROM runner_jobs
         WHERE command_id = ? AND status = 'failed'
           AND json_extract(result, '$.classification') = 'invalid_context'
         ORDER BY completed_at DESC, created_at DESC LIMIT 1`,
      )
      .bind(`auto-${jobType}-${snapshot.id}`)
      .first();
    if (invalidContext) return;
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

  if (jobType === "develop") {
    const ordinaryFailure = await env.DB
      .prepare(
        `SELECT id FROM runner_jobs
         WHERE command_id = ? AND status = 'failed'
           AND COALESCE(result, '') NOT LIKE '%waiting_version%'
           AND COALESCE(result, '') NOT LIKE '%waiting:%'
           AND COALESCE(result, '') NOT LIKE '%needs_human%'
           AND COALESCE(result, '') NOT LIKE '%needs_info%'
           AND COALESCE(json_extract(result, '$.classification'), '') <> 'invalid_context'
         ORDER BY completed_at DESC, created_at DESC LIMIT 1`,
      )
      .bind(`auto-develop-${snapshot.id}`)
      .first();
    const productRework = await loadCurrentReworkFindings(env.DB, snapshot.id);
    if (ordinaryFailure && productRework.findings?.length === 0) return;
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

  let acceptanceCriteria;
  let analysisPlatforms = [];
  let rejectionFindings;
  const contextErrors = [];
  if (jobType === "develop" || jobType === "accept" || jobType === "stage_task") {
    const analysis = await loadAnalysisCriteria(env.DB, snapshot.id);
    acceptanceCriteria = analysis.criteria;
    analysisPlatforms = analysis.platforms ?? [];
    if (analysis.error) contextErrors.push(analysis.error);
  }
  if (jobType === "develop") {
    const rejectedAcceptance = await loadCurrentReworkFindings(env.DB, snapshot.id);
    rejectionFindings = rejectedAcceptance.findings;
    if (rejectedAcceptance.error) contextErrors.push(rejectedAcceptance.error);
  }
  let developmentResult = null;
  if (jobType === "accept" || jobType === "stage_task") {
    const developed = await env.DB
      .prepare(
        `SELECT result FROM runner_jobs
         WHERE job_type = 'develop' AND status = 'completed'
           AND json_extract(payload, '$.taskId') = ?
         ORDER BY completed_at DESC LIMIT 1`,
      )
      .bind(snapshot.id)
      .first();
    if (developed?.result) developmentResult = JSON.parse(developed.result);
  }
  const payload = stagingRecoveryPayload
    ? { ...stagingRecoveryPayload, aggregateVersion: aggregate.version }
    : {
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
        ...(jobType === "develop" || jobType === "accept"
          ? { acceptanceCriteria: acceptanceCriteria ?? null }
          : {}),
        ...(jobType === "develop" ? { rejectionFindings: rejectionFindings ?? [] } : {}),
        ...(contextErrors.length > 0 ? { contextError: contextErrors.join("; ") } : {}),
        commitSha: acceptedResult?.commitSha ?? developmentResult?.commitSha ?? null,
        ...(jobType === "accept" && Array.isArray(developmentResult?.changedPaths)
          ? { changedPaths: developmentResult.changedPaths }
          : {}),
        pr: developmentResult?.pr ?? null,
        platforms: (() => {
          const snapshotPlatforms = normalizePlatforms(snapshot.platforms);
          if (snapshotPlatforms.length > 0) return snapshotPlatforms;
          const developedPlatforms = normalizePlatforms(developmentResult?.platforms);
          if (developedPlatforms.length > 0) return developedPlatforms;
          return analysisPlatforms;
        })(),
        targetVersion: snapshot.targetVersion ?? acceptedResult?.targetVersion ?? null,
        aggregateVersion: aggregate.version,
      };
  await enqueueJob(env.DB, {
    jobId,
    commandId: `auto-${jobType}-${snapshot.id}`,
    jobType,
    payload,
    payloadHash: snapshot.fieldsHash,
    expiresAt: addMinutes(now, 90),
    createdAt: now,
  });
}

async function ensureVersionAssignmentJob(env, snapshot, now) {
  const commandId = `auto-assign-version-${snapshot.id}`;
  const rows = await env.DB
    .prepare(
      `SELECT id, status, created_at, completed_at
       FROM runner_jobs
       WHERE command_id = ? AND job_type = 'assign_version'
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(commandId)
    .all();
  const jobs = rows.results ?? [];
  if (jobs.some((job) => ["queued", "claimed", "completed"].includes(job.status))) {
    return;
  }
  const latestFailure = jobs.find((job) => job.status === "failed");
  if (latestFailure) {
    const retryWindowMinutes = Number(
      env.CLICKUP_VERSION_ASSIGNMENT_RETRY_MINUTES
      ?? env.CLICKUP_JOB_RETRY_MINUTES
      ?? 5,
    );
    const failedAt = latestFailure.completed_at ?? latestFailure.created_at;
    if (failedAt && addMinutes(failedAt, retryWindowMinutes) > now) return;
  }
  const generation = jobs.length + 1;
  const jobId = `${snapshot.id}-assign-version-${generation}`;
  await enqueueJob(env.DB, {
    jobId,
    commandId,
    jobType: "assign_version",
    payload: { taskId: snapshot.id },
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

    // 无目标版本的 inbox 先派发独立的 AI 选版作业，并等待 ClickUp 下一轮读回确认。
    // 在此之前不创建聚合、不写 ClickUp 状态、不派发正式 analysis 作业。
    if (snapshot.status === "inbox" && !snapshot.targetVersion) {
      if (currentDevVersion) {
        await ensureVersionAssignmentJob(env, snapshot, now);
      }
      if (changes.length > 0) {
        processed += 1;
        await saveSnapshot(env.DB, { type: "task", snapshot, readAt: now });
      }
      continue;
    }

    // A manual pause is authoritative even when the task is not in the current version.
    // Reconcile it before the version gate can skip all other task processing.
    await reconcileManualWaitingInfo(env, snapshot, now, commands, config);
    // A completed test is terminal evidence. Record only the safe ready_for_test ->
    // ready_for_release transition before the version gate, including older versions.
    await reconcileManualTestPassed(env, snapshot, now, commands, config);

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
      await ensureExternalTaskImport(env, snapshot, now, commands, config);
      await ensureStateJob(env, snapshot, now, currentDevVersion);
      if (snapshot.status === "ready_for_release") {
        await resolveSatisfiedReworkBlockers({ db: env.DB, taskId: snapshot.id, now, dryRun: false });
      }
      continue;
    }
    processed += 1;
    let aggregate = await loadAggregate(env.DB, "task", snapshot.id);
    const manualDevelopmentStart = confirmed?.status === "ready_for_development"
      && changes.some((change) => (
        change.field === "status"
        && change.from === "ready_for_development"
        && change.to === "developing"
      ));

    // 仅接受已确认的 waiting_info -> analyzing/developing 状态变化作为显式恢复。
    if (aggregate.state === "waiting_info") {
      const resumeAnalysis = changes.some((change) => (
        change.field === "status"
        && change.from === "waiting_info"
        && change.to === "analyzing"
      ));
      const resumeDevelopment = changes.some((change) => (
        change.field === "status"
        && change.from === "waiting_info"
        && change.to === "developing"
      ));
      if (resumeAnalysis) {
        await resumeAnalysisAfterInfo(env, snapshot, now, commands, config);
      } else if (resumeDevelopment) {
        await resumeDevelopmentAfterInfo(env, snapshot, now, commands, config);
      }
      aggregate = await loadAggregate(env.DB, "task", snapshot.id);
    }
    const explicitRejectedDevelopmentRecovery = aggregate.state === "acceptance_rejected"
      && snapshot.status === "ready_for_development"
      && changes.some((change) => (
        change.field === "status"
        && change.from === "acceptance_rejected"
        && change.to === "ready_for_development"
      ));
    const explicitRejectedTestRecovery = aggregate.state === "acceptance_rejected"
      && snapshot.status === "ready_for_test"
      && changes.some((change) => (
        change.field === "status"
        && change.from === "acceptance_rejected"
        && change.to === "ready_for_test"
      ));
    await handleStatusDrivenFlow(env, snapshot, now, commands, config, {
      manualDevelopmentStart,
      explicitRejectedDevelopmentRecovery,
      explicitRejectedTestRecovery,
    });
    await ensureInboxAnalysis(env, snapshot, now, commands, config);
    await ensureExternalTaskImport(env, snapshot, now, commands, config);
    await ensureStateJob(env, snapshot, now, currentDevVersion);
    await saveSnapshot(env.DB, { type: "task", snapshot, readAt: now });
    if (snapshot.status === "ready_for_release") {
      await resolveSatisfiedReworkBlockers({ db: env.DB, taskId: snapshot.id, now, dryRun: false });
    }
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
 * 外部导入：任务无聚合记录（从未进入编排流程），但用户已手动把状态放到
 * 待开发/开发中（如补完信息后直接拖到开发）。系统按「已就绪任务」初始化聚合
 * （inbox -> analyzing -> ready_for_development），使后续开发作业可正常执行。
 * 仅限 ready_for_development / developing 两个状态；其它状态走正常流程。
 */
async function ensureExternalTaskImport(env, snapshot, now, commands, config) {
  if (!["ready_for_development", "developing"].includes(snapshot.status)) return;
  const aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  if (aggregate.version !== 0) return;
  const startId = `poller-import-start-${snapshot.id}`;
  const doneId = `poller-import-done-${snapshot.id}`;
  if (await loadCommandResult(env.DB, startId)) return;
  commands.push(await runCommand(env, parseCommandEnvelope({
    id: startId,
    type: "start_analysis",
    aggregateType: "task",
    aggregateId: snapshot.id,
    expectedVersion: 1,
    actorId: "system-poller",
    issuedAt: now,
    reason: "external task admitted (already ready for development)",
    parameters: {},
  }), now, config));
  commands.push(await runCommand(env, parseCommandEnvelope({
    id: doneId,
    type: "analysis_completed",
    aggregateType: "task",
    aggregateId: snapshot.id,
    expectedVersion: 2,
    actorId: "system-poller",
    issuedAt: now,
    reason: "external task already ready for development",
    parameters: {},
  }), now, config));
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

async function handleStatusDrivenFlow(
  env,
  snapshot,
  now,
  commands,
  config,
  {
    manualDevelopmentStart = false,
    explicitRejectedDevelopmentRecovery = false,
    explicitRejectedTestRecovery = false,
  } = {},
) {

  let aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  if (
    manualDevelopmentStart
    && aggregate.state === "ready_for_development"
    && snapshot.status === "developing"
  ) {
    await env.DB.prepare("DELETE FROM runner_jobs WHERE id = ?").bind("acceptance-paused-" + snapshot.id).run();
    await clearOrdinaryDevelopmentFailures(env.DB, snapshot.id);
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
  if (
    explicitRejectedDevelopmentRecovery
    && aggregate.state === "acceptance_rejected"
    && snapshot.status === "ready_for_development"
  ) {
    const recovery = await loadStagingRecovery(env.DB, snapshot.id);
    if (recovery.kind === "blocked") {
      await postStagingRecoveryBlocked(env, snapshot.id, recovery.reason);
      return;
    }
    const retryStaging = recovery.kind === "staging_infrastructure";
    if (!retryStaging) await clearOrdinaryDevelopmentFailures(env.DB, snapshot.id);
    const commandId = retryStaging
      ? "poller-retry-staging-" + snapshot.id + "-" + (aggregate.version + 1)
      : "poller-rejected-to-dev-" + snapshot.id + "-" + (aggregate.version + 1);
    if (!(await loadCommandResult(env.DB, commandId))) {
      commands.push(await runCommand(env, parseCommandEnvelope({
        id: commandId,
        type: retryStaging ? "retry_staging" : "acceptance_rejected_to_develop",
        aggregateType: "task",
        aggregateId: snapshot.id,
        expectedVersion: aggregate.version + 1,
        actorId: "system-poller",
        issuedAt: now,
        reason: retryStaging
          ? "user explicitly retried staging infrastructure"
          : "user routed rejected task back to rework",
        parameters: {},
      }), now, config));
    }
    aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  }
  if (
    explicitRejectedTestRecovery
    && aggregate.state === "acceptance_rejected"
    && snapshot.status === "ready_for_test"
  ) {
    const recovery = await loadStagingRecovery(env.DB, snapshot.id);
    if (recovery.kind === "blocked") {
      await postStagingRecoveryBlocked(env, snapshot.id, recovery.reason);
      return;
    }
    const retryStaging = recovery.kind === "staging_infrastructure";
    const commandId = retryStaging
      ? "poller-retry-staging-" + snapshot.id + "-" + (aggregate.version + 1)
      : "poller-rejected-to-test-" + snapshot.id + "-" + (aggregate.version + 1);
    if (!(await loadCommandResult(env.DB, commandId))) {
      commands.push(await runCommand(env, parseCommandEnvelope({
        id: commandId,
        type: retryStaging ? "retry_staging" : "acceptance_rejected_to_test",
        aggregateType: "task",
        aggregateId: snapshot.id,
        expectedVersion: aggregate.version + 1,
        actorId: "system-poller",
        issuedAt: now,
        reason: retryStaging
          ? "user explicitly retried staging infrastructure"
          : "user routed rejected task to testing",
        parameters: {},
      }), now, config));
    }
    aggregate = await loadAggregate(env.DB, "task", snapshot.id);
  }

  if (aggregate.state === "ready_for_test" && snapshot.status === "ready_for_development") {
    await clearOrdinaryDevelopmentFailures(env.DB, snapshot.id);
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

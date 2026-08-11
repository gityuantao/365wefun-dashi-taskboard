import { parseCommandEnvelope } from "../domain/commands.mjs";
import { redactCredentials } from "../domain/redaction.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import { dispatchCommand } from "./dispatch-command.mjs";
import { resetRework } from "./failure-handler.mjs";
import { executeIosStagingGate } from "./ios-staging-coordinator.mjs";
import { requiresIosStaging } from "../domain/platforms.mjs";
import { loadIosApps } from "../ios/app-registry.mjs";

const DEFAULT_STAGING_LEASE_MS = 45 * 60_000;

function normalizeRedactedError(value) {
  return redactCredentials(value ?? "unknown error")
    .replace(/\s+/g, " ")
    .trim();
}

function concise(value, max = 300) {
  return normalizeRedactedError(value).slice(0, max);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function nextAttempt(db, taskId) {
  const row = await db.prepare(
    "SELECT COALESCE(MAX(attempt), 0) AS attempt FROM staging_deployments WHERE task_id = ?",
  ).bind(taskId).first();
  return Number(row?.attempt ?? 0) + 1;
}

async function acquireStagingLease(db, holder, now, leaseMs = DEFAULT_STAGING_LEASE_MS) {
  const expiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
  await db.prepare(
    `INSERT INTO orchestration_leases (
       id, aggregate_type, aggregate_id, holder, fencing_token, expires_at, created_at
     ) VALUES ('staging-environment', 'version', 'staging-environment', ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       holder = excluded.holder,
       fencing_token = orchestration_leases.fencing_token + 1,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at
     WHERE orchestration_leases.expires_at <= ?`,
  ).bind(holder, expiresAt, now, now).run();
  const lease = await db.prepare(
    "SELECT holder, fencing_token FROM orchestration_leases WHERE id = 'staging-environment'",
  ).first();
  if (lease?.holder !== holder) throw new Error("staging environment is being deployed by another task");
  return Number(lease.fencing_token);
}

async function renewStagingLease(db, holder, fencingToken, now, leaseMs) {
  const expiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
  const updated = await db.prepare(
    `UPDATE orchestration_leases SET expires_at = ?
     WHERE id = 'staging-environment' AND holder = ? AND fencing_token = ?
       AND expires_at > ?`,
  ).bind(expiresAt, holder, fencingToken, now).run();
  if ((updated.meta?.changes ?? 0) === 0) {
    throw new Error("staging environment lease was lost");
  }
}

async function releaseStagingLease(db, holder, fencingToken) {
  await db.prepare(
    "DELETE FROM orchestration_leases WHERE id = 'staging-environment' AND holder = ? AND fencing_token = ?",
  ).bind(holder, fencingToken).run();
}

async function transitionFailure({
  db,
  client,
  taskId,
  jobId,
  attemptId,
  candidateCommit,
  stage,
  error,
  now,
}) {
  const normalizedError = normalizeRedactedError(error?.message ?? error);
  const reason = normalizedError.slice(0, 300);
  const candidateIdentity = candidateCommit ?? "unknown";
  const fingerprint = await sha256Hex([
    taskId,
    candidateIdentity,
    stage,
    "staging_infrastructure",
    normalizedError,
  ].join("|"));
  const previous = await db.prepare(
    `SELECT id FROM staging_deployments
     WHERE task_id = ? AND COALESCE(candidate_commit, 'unknown') = ?
       AND failure_fingerprint = ? AND status = 'failed' AND id != ?
     ORDER BY attempt DESC LIMIT 1`,
  ).bind(taskId, candidateIdentity, fingerprint, attemptId ?? "").first();
  const repeated = previous !== null;
  if (attemptId) {
    await db.prepare(
      `UPDATE staging_deployments SET
         failure_owner = 'staging_infrastructure',
         failure_classification = 'staging_infrastructure',
         failure_fingerprint = ?
       WHERE id = ?`,
    ).bind(fingerprint, attemptId).run();
  }
  const aggregate = await loadAggregate(db, "task", taskId);
  if (aggregate.state === "accepting") {
    await dispatchCommand({
      db,
      command: parseCommandEnvelope({
        id: `staging-failed-${jobId}-${aggregate.version + 1}`,
        type: "acceptance_rejected",
        aggregateType: "task",
        aggregateId: taskId,
        expectedVersion: aggregate.version + 1,
        actorId: "runner-staging",
        issuedAt: now,
        reason: "staging deployment failed",
        parameters: { evidenceId: `staging-${jobId}` },
      }),
      now,
    });
  }
  try {
    await client.postComment(taskId, [
      "❌ 测试环境部署失败",
      "产品开发已完成，当前为提测基础设施故障",
      "故障归属：staging_infrastructure",
      `阶段：${stage}`,
      `原因：${reason}`,
      `故障指纹：${fingerprint}`,
      `重复故障：${repeated ? "是" : "否"}`,
      "任务已转为「验收不通过」，不计入产品返工次数",
    ].join("\n"));
  } catch {}
  return {
    status: "failed",
    classification: "staging_infrastructure",
    stage,
    error: reason,
    fingerprint,
    repeated,
  };
}

function successComment({ taskCommit, versionBranch, deployment, observed, iosEvidence }) {
  return [
    "✅ 测试环境已部署，进入待测试",
    `任务提交：${taskCommit}`,
    `版本分支：${versionBranch}`,
    `运行版本：${observed.gitSha}`,
    `Web/API Release：${observed.releaseId ?? deployment.releaseId ?? "未提供"}`,
    `测试地址：${(observed.urls ?? [deployment.url]).filter(Boolean).join("、")}`,
    `部署时间：${observed.deployedAt ?? new Date().toISOString()}`,
    ...iosEvidence.map((app) => [
      `TestFlight ${app.name} (${app.id})：`,
      `scheme=${app.scheme}`,
      `bundle=${app.bundleId}`,
      `version=${app.marketingVersion}`,
      `build=${app.buildNumber}`,
      `upload=${app.uploadId}`,
      `group=${app.testGroup}`,
    ].join(" | ")),
  ].join("\n");
}

export async function executeStagingGate({
  job,
  db,
  client,
  gitOps,
  adapter,
  iosApps = null,
  iosAdapter = null,
  beforeExternalOperation = async () => {},
  stagingLeaseMs = DEFAULT_STAGING_LEASE_MS,
  now,
}) {
  const { taskId, pr, commitSha, versionBranch, targetVersion, platforms } = job.payload;
  let stage = "preflight";
  let attemptId = null;
  let fencingToken = null;
  let candidateCommit = null;
  try {
    if (!pr?.url || !commitSha || !versionBranch || !targetVersion) {
      throw new Error(
        "staging evidence is incomplete: PR, accepted commit, version branch and target version are required",
      );
    }
    const aggregate = await loadAggregate(db, "task", taskId);
    if (aggregate.state !== "accepting") {
      throw new Error(`stale staging job: task is in ${aggregate.state}`);
    }
    const attempt = await nextAttempt(db, taskId);
    attemptId = `${taskId}-staging-${attempt}`;
    await db.prepare(
      `INSERT INTO staging_deployments (
         id, task_id, target_version, pr_url, task_commit, version_branch,
         stage, status, attempt, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'preflight', 'running', ?, ?)`,
    ).bind(attemptId, taskId, targetVersion, pr.url, commitSha, versionBranch, attempt, now).run();

    if (!adapter || typeof adapter.deploy !== "function" || typeof adapter.readback !== "function") {
      throw new Error("staging adapter is not configured");
    }

    stage = "merge";
    const integrated = await gitOps.integrateTaskPr({ taskId, pullRequest: pr.url, versionBranch });
    if (!integrated.merged) throw new Error(integrated.error ?? "task PR merge failed");
    candidateCommit = integrated.candidateCommit;
    const taskCommit = integrated.taskHead;
    if (taskCommit !== commitSha) {
      throw new Error(
        `accepted commit ${commitSha} does not match PR head ${taskCommit ?? "missing"}`,
      );
    }
    await db.prepare(
      "UPDATE staging_deployments SET stage = ?, task_commit = ?, candidate_commit = ? WHERE id = ?",
    ).bind(stage, taskCommit, candidateCommit, attemptId).run();

    stage = "persist_candidate";
    const persisted = await gitOps.persistCandidate({
      versionId: targetVersion,
      versionBranch,
      candidateCommit,
      taskPrHeads: [{ taskId, headCommit: taskCommit, prNumber: integrated.prNumber }],
    });
    if (!persisted.persisted) throw new Error(persisted.error ?? "candidate push failed");

    stage = "staging_lease";
    fencingToken = await acquireStagingLease(
      db,
      job.id,
      new Date().toISOString(),
      stagingLeaseMs,
    );
    const guardStagingOwnership = async () => {
      await beforeExternalOperation();
      await renewStagingLease(
        db,
        job.id,
        fencingToken,
        new Date().toISOString(),
        stagingLeaseMs,
      );
    };
    const withStagingOwnership = async (operation) => {
      await guardStagingOwnership();
      try {
        return await operation();
      } finally {
        await guardStagingOwnership();
      }
    };
    stage = "deploy";
    await db.prepare("UPDATE staging_deployments SET stage = ? WHERE id = ?").bind(stage, attemptId).run();
    const deployment = await adapter.deploy({ candidateCommit, versionBranch, taskId, targetVersion });
    stage = "readback";
    const observed = await adapter.readback({ deployment, candidateCommit });
    if (observed.confirmed !== true || observed.gitSha !== candidateCommit) {
      throw new Error(`staging runtime SHA ${observed.gitSha ?? "missing"} does not match ${candidateCommit}`);
    }
    let iosEvidence = [];
    const iosRequired = requiresIosStaging(platforms);
    if (iosRequired) {
      stage = "testflight:all:configuration";
      const validatedIosApps = loadIosApps(iosApps);
      if (
        iosAdapter === null
        || typeof iosAdapter !== "object"
        || typeof iosAdapter.stage !== "function"
        || typeof iosAdapter.readback !== "function"
      ) {
        throw new Error("iOS TestFlight adapter is not configured");
      }
      const iosResult = await executeIosStagingGate({
        db,
        client,
        taskId,
        candidateCommit,
        targetVersion,
        apps: validatedIosApps,
        adapter: {
          stage: (options) => withStagingOwnership(() => iosAdapter.stage(options)),
          readback: (options) => withStagingOwnership(() => iosAdapter.readback(options)),
        },
        beforeSuccessSideEffect: guardStagingOwnership,
        now,
      });
      if (iosResult.status !== "completed") {
        const appId = iosResult.error?.appId ?? "unknown";
        const iosStage = iosResult.error?.stage ?? "unknown";
        stage = `testflight:${appId}:${iosStage}`;
        throw new Error(iosResult.error?.message ?? "TestFlight gate failed");
      }
      iosEvidence = iosResult.apps;
    }
    stage = iosRequired ? "testflight:all:finalize" : "finalize";
    await guardStagingOwnership();
    await db.prepare(
      `UPDATE staging_deployments SET stage = 'complete', status = 'succeeded', release_id = ?,
         observed_git_sha = ?, urls = ?, completed_at = ? WHERE id = ?`,
    ).bind(
      observed.releaseId ?? deployment.releaseId ?? null,
      observed.gitSha,
      JSON.stringify(observed.urls ?? [deployment.url].filter(Boolean)),
      observed.deployedAt ?? new Date().toISOString(),
      attemptId,
    ).run();
    const current = await loadAggregate(db, "task", taskId);
    if (current.state !== "accepting") throw new Error(`task changed to ${current.state} before staging completion`);
    const command = parseCommandEnvelope({
      id: `staging-passed-${job.id}`,
      type: "acceptance_passed",
      aggregateType: "task",
      aggregateId: taskId,
      expectedVersion: current.version + 1,
      actorId: "runner-staging",
      issuedAt: new Date().toISOString(),
      reason: "staging deployment confirmed",
      parameters: { targetVersion },
    });
    await guardStagingOwnership();
    const result = await dispatchCommand({ db, command, now: new Date().toISOString() });
    await guardStagingOwnership();
    await resetRework({ db, taskId });
    await guardStagingOwnership();
    await client.postComment(taskId, successComment({
      taskCommit,
      versionBranch,
      deployment,
      observed,
      iosEvidence,
    }));
    return {
      status: "completed",
      commandId: result.commandId,
      deployment,
      observed,
      ios: iosEvidence,
    };
  } catch (error) {
    if (attemptId) {
      await db.prepare(
        `UPDATE staging_deployments SET stage = ?, status = 'failed', error = ?, completed_at = ?
         WHERE id = ?`,
      ).bind(stage, concise(error.message), new Date().toISOString(), attemptId).run();
    }
    return transitionFailure({
      db,
      client,
      taskId,
      jobId: job.id,
      attemptId,
      candidateCommit,
      stage,
      error,
      now: new Date().toISOString(),
    });
  } finally {
    if (fencingToken !== null) await releaseStagingLease(db, job.id, fencingToken);
  }
}

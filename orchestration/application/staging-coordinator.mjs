import { parseCommandEnvelope } from "../domain/commands.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import { dispatchCommand } from "./dispatch-command.mjs";
import { recordFailure, resetRework } from "./failure-handler.mjs";

function concise(value, max = 300) {
  return String(value ?? "unknown error")
    .replace(/(?:bearer|basic)\s+\S+/gi, "[REDACTED]")
    .replace(/((?:password|token|secret|key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

async function nextAttempt(db, taskId) {
  const row = await db.prepare(
    "SELECT COALESCE(MAX(attempt), 0) AS attempt FROM staging_deployments WHERE task_id = ?",
  ).bind(taskId).first();
  return Number(row?.attempt ?? 0) + 1;
}

async function acquireStagingLease(db, holder, now, minutes = 45) {
  const expiresAt = new Date(Date.parse(now) + minutes * 60_000).toISOString();
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

async function releaseStagingLease(db, holder, fencingToken) {
  await db.prepare(
    "DELETE FROM orchestration_leases WHERE id = 'staging-environment' AND holder = ? AND fencing_token = ?",
  ).bind(holder, fencingToken).run();
}

async function transitionFailure({ db, client, taskId, jobId, stage, error, now }) {
  const reason = concise(error?.message ?? error);
  const failure = await recordFailure({
    db,
    taskId,
    reason: `staging ${stage}: ${reason}`,
    evidence: `staging-${jobId}`,
    now,
  });
  const aggregate = await loadAggregate(db, "task", taskId);
  if (aggregate.state === "accepting") {
    await dispatchCommand({
      db,
      command: parseCommandEnvelope({
        id: `staging-failed-${jobId}-${aggregate.version + 1}`,
        type: failure.blocked ? "acceptance_rejected" : "staging_failed",
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
  const outcome = failure.blocked
    ? "连续失败已达到返工上限，转为「验收不通过」"
    : "已退回「待开发」，下一轮开发将继续处理";
  try {
    await client.postComment(taskId, [
      "❌ 测试环境部署失败",
      `阶段：${stage}`,
      `原因：${reason}`,
      outcome,
    ].join("\n"));
  } catch {}
  return { status: "failed", classification: "staging_failure", stage, error: reason };
}

export async function executeStagingGate({ job, db, client, gitOps, adapter, now }) {
  const { taskId, pr, commitSha, versionBranch, targetVersion } = job.payload;
  let stage = "preflight";
  let attemptId = null;
  let fencingToken = null;
  let candidateCommit = null;
  try {
    if (!adapter || typeof adapter.deploy !== "function" || typeof adapter.readback !== "function") {
      throw new Error("staging adapter is not configured");
    }
    if (!pr?.url || !versionBranch || !targetVersion) {
      throw new Error("staging evidence is incomplete: PR, version branch and target version are required");
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
    ).bind(attemptId, taskId, targetVersion, pr.url, commitSha ?? "unknown", versionBranch, attempt, now).run();

    stage = "merge";
    const integrated = await gitOps.integrateTaskPr({ taskId, pullRequest: pr.url, versionBranch });
    if (!integrated.merged) throw new Error(integrated.error ?? "task PR merge failed");
    candidateCommit = integrated.candidateCommit;
    const taskCommit = integrated.taskHead;
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
    fencingToken = await acquireStagingLease(db, job.id, new Date().toISOString());
    stage = "deploy";
    await db.prepare("UPDATE staging_deployments SET stage = ? WHERE id = ?").bind(stage, attemptId).run();
    const deployment = await adapter.deploy({ candidateCommit, versionBranch, taskId, targetVersion });
    stage = "readback";
    const observed = await adapter.readback({ deployment, candidateCommit });
    if (observed.confirmed !== true || observed.gitSha !== candidateCommit) {
      throw new Error(`staging runtime SHA ${observed.gitSha ?? "missing"} does not match ${candidateCommit}`);
    }
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
    const result = await dispatchCommand({ db, command, now: new Date().toISOString() });
    await resetRework({ db, taskId });
    await client.postComment(taskId, [
      "✅ 测试环境已部署，进入待测试",
      `任务提交：${taskCommit}`,
      `版本分支：${versionBranch}`,
      `运行版本：${observed.gitSha}`,
      `Release：${observed.releaseId ?? deployment.releaseId ?? "未提供"}`,
      `测试地址：${(observed.urls ?? [deployment.url]).filter(Boolean).join("、")}`,
      `部署时间：${observed.deployedAt ?? new Date().toISOString()}`,
    ].join("\n"));
    return { status: "completed", commandId: result.commandId, deployment, observed };
  } catch (error) {
    if (attemptId) {
      await db.prepare(
        `UPDATE staging_deployments SET stage = ?, status = 'failed', error = ?, completed_at = ?
         WHERE id = ?`,
      ).bind(stage, concise(error.message), new Date().toISOString(), attemptId).run();
    }
    return transitionFailure({ db, client, taskId, jobId: job.id, stage, error, now: new Date().toISOString() });
  } finally {
    if (fencingToken !== null) await releaseStagingLease(db, job.id, fencingToken);
  }
}

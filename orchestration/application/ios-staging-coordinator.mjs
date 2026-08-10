import { enabledIosApps } from "../ios/app-registry.mjs";
import { redactCredentials, sanitizeObservedEvidenceString } from "../domain/redaction.mjs";

function concise(value, max = 300) {
  return redactCredentials(value ?? "unknown error")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function timestamp(now) {
  if (typeof now === "string" && now.trim() !== "") return now;
  if (now instanceof Date) return now.toISOString();
  return new Date().toISOString();
}

function appSnapshot(apps) {
  return enabledIosApps(apps).map((app) => Object.freeze({
    id: app.id,
    name: app.name,
    scheme: app.scheme,
    bundleId: app.bundleId,
    testFlightGroup: app.testFlightGroup,
  }));
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`TestFlight evidence missing ${field}`);
  }
  return value;
}

function requireStagedEvidence(staged, { app, candidateCommit, targetVersion }) {
  const expected = {
    appId: app.id,
    scheme: app.scheme,
    bundleId: app.bundleId,
    marketingVersion: targetVersion,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (staged?.[field] !== value) {
      throw new Error(`TestFlight stage evidence ${field} does not match ${app.id} for Candidate ${candidateCommit}`);
    }
  }
  return {
    ...expected,
    buildNumber: requireString(staged.buildNumber, "buildNumber"),
    uploadId: requireString(staged.uploadId, "uploadId"),
  };
}

function reusableStagedEvidence(app, row) {
  return {
    appId: app.id,
    scheme: app.scheme,
    bundleId: app.bundleId,
    marketingVersion: row.marketing_version,
    buildNumber: row.build_number,
    uploadId: row.upload_id,
  };
}

function confirmedEvidence(app, staged, observed, reused = false) {
  return {
    id: app.id,
    name: app.name,
    scheme: app.scheme,
    bundleId: app.bundleId,
    marketingVersion: staged.marketingVersion,
    buildNumber: staged.buildNumber,
    uploadId: staged.uploadId,
    processingStatus: "processed",
    testGroup: observed.testGroup,
    membershipConfirmed: true,
    checkedAt: observed.checkedAt,
    reused,
  };
}

async function findReusableSuccess(db, { taskId, candidateCommit, targetVersion, app }) {
  return db.prepare(`
    SELECT attempt, marketing_version, build_number, upload_id, processing_status,
           test_group, membership_confirmed, completed_at
    FROM ios_testflight_deployments
    WHERE task_id = ?
      AND candidate_commit = ?
      AND app_id = ?
      AND scheme = ?
      AND bundle_id = ?
      AND marketing_version = ?
      AND test_group = ?
      AND status = 'succeeded'
      AND stage = 'complete'
      AND processing_status = 'processed'
      AND membership_confirmed = 1
      AND build_number IS NOT NULL
      AND upload_id IS NOT NULL
      AND completed_at IS NOT NULL
    ORDER BY attempt DESC
    LIMIT 1
  `).bind(
    taskId,
    candidateCommit,
    app.id,
    app.scheme,
    app.bundleId,
    targetVersion,
    app.testFlightGroup,
  ).first();
}

async function nextAttempt(db, { taskId, candidateCommit, appId }) {
  const row = await db.prepare(`
    SELECT COALESCE(MAX(attempt), 0) AS attempt
    FROM ios_testflight_deployments
    WHERE task_id = ? AND candidate_commit = ? AND app_id = ?
  `).bind(taskId, candidateCommit, appId).first();
  return Number(row?.attempt ?? 0) + 1;
}

async function beginAttempt(db, { taskId, candidateCommit, targetVersion, app, attempt, now }) {
  await db.prepare(`
    INSERT INTO ios_testflight_deployments (
      task_id, candidate_commit, app_id, attempt, scheme, bundle_id,
      marketing_version, test_group, membership_confirmed, stage, status, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'prepare', 'running', ?)
  `).bind(
    taskId,
    candidateCommit,
    app.id,
    attempt,
    app.scheme,
    app.bundleId,
    targetVersion,
    app.testFlightGroup,
    now,
  ).run();
}

async function recordUpload(db, { taskId, candidateCommit, appId, attempt, staged }) {
  await db.prepare(`
    UPDATE ios_testflight_deployments
    SET build_number = ?, upload_id = ?, stage = 'processing'
    WHERE task_id = ? AND candidate_commit = ? AND app_id = ? AND attempt = ?
  `).bind(
    staged.buildNumber,
    staged.uploadId,
    taskId,
    candidateCommit,
    appId,
    attempt,
  ).run();
}

async function recordReadback(db, { taskId, candidateCommit, appId, attempt, observed, stage }) {
  await db.prepare(`
    UPDATE ios_testflight_deployments
    SET processing_status = ?, test_group = COALESCE(?, test_group), membership_confirmed = ?, stage = ?
    WHERE task_id = ? AND candidate_commit = ? AND app_id = ? AND attempt = ?
  `).bind(
    typeof observed?.processingStatus === "string" ? observed.processingStatus : null,
    typeof observed?.testGroup === "string" ? observed.testGroup : null,
    observed?.membershipConfirmed === true ? 1 : 0,
    stage,
    taskId,
    candidateCommit,
    appId,
    attempt,
  ).run();
}

async function completeAttempt(db, { taskId, candidateCommit, appId, attempt, completedAt }) {
  await db.prepare(`
    UPDATE ios_testflight_deployments
    SET processing_status = 'processed', membership_confirmed = 1,
        stage = 'complete', status = 'succeeded', error = NULL, completed_at = ?
    WHERE task_id = ? AND candidate_commit = ? AND app_id = ? AND attempt = ?
  `).bind(completedAt, taskId, candidateCommit, appId, attempt).run();
}

async function failAttempt(db, { taskId, candidateCommit, appId, attempt, stage, error, completedAt }) {
  await db.prepare(`
    UPDATE ios_testflight_deployments
    SET stage = ?, status = 'failed', error = ?, completed_at = ?
    WHERE task_id = ? AND candidate_commit = ? AND app_id = ? AND attempt = ?
  `).bind(stage, error, completedAt, taskId, candidateCommit, appId, attempt).run();
}

async function recordReuseFailure(db, {
  taskId,
  candidateCommit,
  app,
  reusable,
  observed,
  stage,
  classification,
  error,
  occurredAt,
}) {
  const attempt = await nextAttempt(db, { taskId, candidateCommit, appId: app.id });
  await db.prepare(`
    INSERT INTO ios_testflight_deployments (
      task_id, candidate_commit, app_id, attempt, scheme, bundle_id,
      marketing_version, build_number, upload_id, processing_status,
      test_group, membership_confirmed, stage, status, failure_classification,
      error, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?)
  `).bind(
    taskId,
    candidateCommit,
    app.id,
    attempt,
    app.scheme,
    app.bundleId,
    reusable.marketing_version,
    reusable.build_number,
    reusable.upload_id,
    sanitizeObservedEvidenceString(observed?.processingStatus),
    sanitizeObservedEvidenceString(observed?.testGroup) ?? reusable.test_group,
    typeof observed?.membershipConfirmed === "boolean"
      ? (observed.membershipConfirmed ? 1 : 0)
      : null,
    stage,
    classification,
    error,
    occurredAt,
    occurredAt,
  ).run();
}

function readbackFailureStage(error) {
  if (error?.stage === "processing" || error?.stage === "internal_testing") return error.stage;
  return /membership|internal[ _-]?testing|test(?:\s*|_)group/i.test(String(error?.message ?? error))
    ? "internal_testing"
    : "processing";
}

function validateProcessing(observed) {
  if (observed?.processed !== true || observed?.processingStatus !== "processed") {
    throw new Error(`TestFlight build is ${observed?.processingStatus ?? "not processed"}`);
  }
}

function validateMembership(observed, app) {
  if (observed?.testGroup !== app.testFlightGroup || observed?.membershipConfirmed !== true) {
    throw new Error(`TestFlight build is not confirmed in ${app.testFlightGroup}`);
  }
  requireString(observed.checkedAt, "checkedAt");
}

function successComment(candidateCommit, evidence) {
  return [
    "✅ iOS TestFlight 全 App 门禁通过",
    `Candidate：${candidateCommit}`,
    ...evidence.map((app) => [
      `- ${app.name} (${app.id})`,
      `scheme=${app.scheme}`,
      `bundle=${app.bundleId}`,
      `version=${app.marketingVersion}`,
      `build=${app.buildNumber}`,
      `upload=${app.uploadId}`,
      `group=${app.testGroup}`,
    ].join(" | ")),
  ].join("\n");
}

function failureComment({ app, targetVersion, staged, stage, error }) {
  return [
    "❌ iOS TestFlight 门禁失败",
    `App：${app.name} (${app.id})`,
    `Scheme：${app.scheme}`,
    `Bundle ID：${app.bundleId}`,
    `版本：${targetVersion}`,
    `Build：${staged?.buildNumber ?? "未提供"}`,
    `Upload ID：${staged?.uploadId ?? "未提供"}`,
    `阶段：${stage}`,
    `原因：${error}`,
  ].join("\n");
}

async function postFailureComment(client, taskId, text) {
  try {
    await client?.postComment?.(taskId, text);
  } catch {}
}

async function postSuccessComment(client, taskId, text) {
  if (!client || typeof client.postComment !== "function") {
    throw new Error("ClickUp comment client is not configured");
  }
  await client.postComment(taskId, text);
}

export async function executeIosStagingGate({
  db,
  client,
  taskId,
  candidateCommit,
  targetVersion,
  apps,
  adapter,
  beforeSuccessSideEffect = async () => {},
  now,
}) {
  const enabledApps = appSnapshot(apps);
  const confirmedApps = [];
  const occurredAt = timestamp(now);

  for (const app of enabledApps) {
    let attempt = null;
    let stage = "prepare";
    let staged = null;
    let reusable = null;
    let observed = null;
    let failureClassification = null;
    let failureRetryable = null;
    try {
      reusable = await findReusableSuccess(db, {
        taskId,
        candidateCommit,
        targetVersion,
        app,
      });
      if (reusable) {
        staged = reusableStagedEvidence(app, reusable);
        stage = "processing";
        try {
          observed = await adapter.readback({ app, staged });
        } catch (error) {
          if (error?.name === "TestFlightReadbackError" && error.observed) {
            observed = error.observed;
          }
          stage = readbackFailureStage(error);
          const authoritative = error?.stage === "processing" || error?.stage === "internal_testing";
          failureClassification = authoritative ? "authoritative_stale" : "observation_error";
          failureRetryable = !authoritative;
          throw error;
        }
        try {
          validateProcessing(observed);
        } catch (error) {
          failureClassification = "authoritative_stale";
          failureRetryable = false;
          throw error;
        }
        stage = "internal_testing";
        try {
          validateMembership(observed, app);
        } catch (error) {
          failureClassification = "authoritative_stale";
          failureRetryable = false;
          throw error;
        }
        confirmedApps.push(confirmedEvidence(app, staged, observed, true));
        continue;
      }

      attempt = await nextAttempt(db, { taskId, candidateCommit, appId: app.id });
      await beginAttempt(db, {
        taskId,
        candidateCommit,
        targetVersion,
        app,
        attempt,
        now: occurredAt,
      });

      stage = "upload";
      staged = requireStagedEvidence(
        await adapter.stage({ candidateCommit, targetVersion, app }),
        { app, candidateCommit, targetVersion },
      );
      await recordUpload(db, { taskId, candidateCommit, appId: app.id, attempt, staged });

      stage = "processing";
      try {
        observed = await adapter.readback({ app, staged });
      } catch (error) {
        stage = readbackFailureStage(error);
        throw error;
      }
      await recordReadback(db, {
        taskId,
        candidateCommit,
        appId: app.id,
        attempt,
        observed,
        stage: "processing",
      });
      validateProcessing(observed);

      stage = "internal_testing";
      await recordReadback(db, {
        taskId,
        candidateCommit,
        appId: app.id,
        attempt,
        observed,
        stage,
      });
      validateMembership(observed, app);

      const completedAt = observed.checkedAt ?? occurredAt;
      await beforeSuccessSideEffect();
      await completeAttempt(db, {
        taskId,
        candidateCommit,
        appId: app.id,
        attempt,
        completedAt,
      });
      confirmedApps.push(confirmedEvidence(app, staged, observed));
    } catch (error) {
      const message = concise(error?.message ?? error);
      if (reusable !== null && failureClassification !== null) {
        await recordReuseFailure(db, {
          taskId,
          candidateCommit,
          app,
          reusable,
          observed,
          stage,
          classification: failureClassification,
          error: message,
          occurredAt,
        });
      } else if (attempt !== null) {
        await failAttempt(db, {
          taskId,
          candidateCommit,
          appId: app.id,
          attempt,
          stage,
          error: message,
          completedAt: occurredAt,
        });
      }
      await postFailureComment(client, taskId, failureComment({
        app,
        targetVersion,
        staged,
        stage,
        error: message,
      }));
      const failure = {
        appId: app.id,
        appName: app.name,
        stage,
        message,
      };
      if (failureClassification) {
        failure.classification = failureClassification;
        failure.retryable = failureRetryable;
      }
      return {
        status: "failed",
        apps: confirmedApps,
        error: failure,
      };
    }
  }

  try {
    await beforeSuccessSideEffect();
    await postSuccessComment(client, taskId, successComment(candidateCommit, confirmedApps));
  } catch (error) {
    return {
      status: "failed",
      apps: confirmedApps,
      error: {
        appId: "all",
        appName: "All enabled iOS Apps",
        stage: "comment",
        message: concise(error?.message ?? error),
        retryable: true,
      },
    };
  }
  return { status: "completed", apps: confirmedApps };
}

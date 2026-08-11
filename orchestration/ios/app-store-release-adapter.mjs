import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { redactCredentials, sanitizeObservedEvidenceString } from "../domain/redaction.mjs";

const execFile = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 45 * 60_000;
const WAITING_REVIEW_STATES = new Set(["waiting_for_review", "in_review", "pending_developer_release"]);

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`App Store release ${field} is required`);
  return value.trim();
}

function requiredCommand(runtime) {
  const command = runtime?.iosProductionReleaseCommand;
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.trim() === "")) {
    throw new Error("App Store release command is not configured");
  }
  return command;
}

function timeoutFor(runtime) {
  const value = Number(runtime?.iosProductionReleaseTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function parseFinalJson(stdout, label) {
  const line = String(stdout ?? "").trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error(`${label} did not return final JSON evidence`);
  try {
    const value = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value;
  } catch {
    throw new Error(`${label} did not return final JSON evidence`);
  }
}

function sanitizeError(error, mode) {
  const message = redactCredentials(String(error?.message ?? error ?? "unknown App Store release error"));
  const sanitized = new Error(`${mode} failed: ${message}`);
  sanitized.name = "AppStoreReleaseCommandError";
  sanitized.failureClassification = error?.failureClassification ?? "external_unknown";
  if (error?.deterministic === true) sanitized.deterministic = true;
  return sanitized;
}

function baseEnvironment({ runtime, manifest, app, idempotencyKey, evidence = {} }) {
  return {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    IOS_APP_ID: requiredString(app?.id, "app.id"),
    IOS_APP_STORE_APP_ID: requiredString(app?.appStoreAppId, "app.appStoreAppId"),
    IOS_SCHEME: requiredString(app?.scheme, "app.scheme"),
    IOS_TEST_SCHEME: requiredString(app?.testScheme, "app.testScheme"),
    IOS_TEST_TARGET: requiredString(app?.testTarget, "app.testTarget"),
    IOS_BUNDLE_ID: requiredString(app?.bundleId, "app.bundleId"),
    IOS_MARKETING_VERSION: requiredString(app?.marketingVersion, "app.marketingVersion"),
    IOS_RELEASE_MODE: requiredString(app?.releaseMode, "app.releaseMode"),
    IOS_REVIEW_CONFIGURATION_REF: requiredString(app?.reviewConfigurationRef, "app.reviewConfigurationRef"),
    IOS_PRODUCTION_CREDENTIALS_PATH: requiredString(runtime?.iosProductionCredentialsPath, "credentials path"),
    IOS_PRODUCTION_ADAPTER_TIMEOUT_MS: String(timeoutFor(runtime)),
    IOS_PRODUCTION_INTERNAL_TIMEOUT_MS: String(Math.max(1_000, timeoutFor(runtime) - 5_000)),
    IOS_PRODUCTION_REPO_PATH: requiredString(runtime?.repoPath, "repository path"),
    IOS_PRODUCTION_API_URL: String(runtime?.iosProductionApiUrl ?? ""),
    PRODUCTION_VERSION_ID: requiredString(manifest?.versionId, "manifest.versionId"),
    PRODUCTION_CANDIDATE_COMMIT: requiredString(manifest?.candidateCommit, "manifest.candidateCommit"),
    PRODUCTION_MANIFEST_CHECKSUM: requiredString(manifest?.checksum, "manifest.checksum"),
    IOS_PRODUCTION_IDEMPOTENCY_KEY: String(idempotencyKey ?? ""),
    IOS_BUILD_NUMBER: String(evidence.buildNumber ?? ""),
    IOS_UPLOAD_ID: String(evidence.uploadId ?? ""),
    IOS_EXTERNAL_REQUEST_ID: String(evidence.externalRequestId ?? ""),
    IOS_PROCESSING_ID: String(evidence.processingId ?? ""),
    IOS_REVIEW_SUBMISSION_ID: String(evidence.reviewSubmissionId ?? ""),
    IOS_REVIEW_ID: String(evidence.reviewId ?? ""),
    IOS_APP_STORE_VERSION_ID: String(evidence.appStoreVersionId ?? ""),
    IOS_REVIEW_ITEM_ID: String(evidence.reviewItemId ?? ""),
    IOS_RELEASE_ID: String(evidence.releaseId ?? ""),
  };
}

function assertIdentity(evidence, app, expected = {}) {
  const identity = {
    appId: app.id,
    appStoreAppId: app.appStoreAppId,
    bundleId: app.bundleId,
    marketingVersion: app.marketingVersion,
  };
  if (evidence.scheme !== undefined) identity.scheme = app.scheme;
  for (const [field, value] of Object.entries({ ...identity, ...expected })) {
    if (String(evidence?.[field] ?? "") !== String(value)) {
      const error = new Error(`App Store release evidence ${field} does not match the requested App/build`);
      error.deterministic = true;
      error.failureClassification = "validation";
      throw error;
    }
  }
  return evidence;
}

function minimalEvidence(value) {
  const result = {};
  for (const field of [
    "appId", "appStoreAppId", "scheme", "bundleId", "marketingVersion", "buildNumber",
    "uploadId", "externalRequestId", "processingId", "processingStatus",
    "appStoreVersionId", "reviewSubmissionId", "reviewItemId", "reviewStatus", "reviewId", "releaseStatus", "releaseId",
    "status", "liveStatus", "liveId", "liveMarketingVersion", "liveBuildNumber", "checkedAt",
  ]) {
    if (value?.[field] !== undefined && value[field] !== null) {
      result[field] = typeof value[field] === "string" ? sanitizeObservedEvidenceString(value[field]) : value[field];
    }
  }
  for (const field of ["automaticRelease", "authoritative", "submissionExists", "liveMembershipConfirmed", "reviewConfigurationApplied"]) {
    if (typeof value?.[field] === "boolean") result[field] = value[field];
  }
  return result;
}

function typedFailure(message, classification) {
  const error = new Error(message);
  error.deterministic = true;
  error.failureClassification = classification;
  return error;
}

export function createAppStoreReleaseAdapter({ runtime = {}, projectRoot, runCommand = execFile } = {}) {
  const [file, ...args] = requiredCommand(runtime);
  const run = async ({ mode, manifest, app, idempotencyKey, evidence, beforeExternalOperation, afterExternalOperation }) => {
    await beforeExternalOperation?.();
    const controller = new AbortController();
    let heartbeatError;
    let heartbeatRunning = false;
    const heartbeatMs = Math.max(1_000, Number(runtime?.iosProductionFenceHeartbeatMs ?? 60_000));
    const heartbeat = beforeExternalOperation ? setInterval(async () => {
      if (heartbeatRunning || heartbeatError) return;
      heartbeatRunning = true;
      try {
        await beforeExternalOperation();
      } catch (error) {
        heartbeatError = error;
        controller.abort(error);
      } finally {
        heartbeatRunning = false;
      }
    }, heartbeatMs) : null;
    heartbeat?.unref?.();
    let result;
    let operationError;
    try {
      result = await runCommand(file, args, {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: timeoutFor(runtime),
        signal: controller.signal,
        env: { ...baseEnvironment({ runtime, manifest, app, idempotencyKey, evidence }), IOS_PRODUCTION_MODE: mode },
      });
    } catch (error) {
      operationError = error;
    }
    if (heartbeat) clearInterval(heartbeat);
    if (heartbeatError) throw heartbeatError;
    await afterExternalOperation?.();
    if (operationError?.deterministic === true) throw operationError;
    if (operationError) throw sanitizeError(operationError, mode);
    const parsed = parseFinalJson(result?.stdout, `App Store ${mode} command`);
    if (parsed.ok === false && parsed.error) {
      const safeMessage = redactCredentials(String(parsed.error.message ?? "App Store production command failed")).slice(0, 1024);
      const allowedClassifications = new Set(["validation", "product_rework", "release_infrastructure", "external_unknown"]);
      const error = new Error(safeMessage);
      error.failureClassification = allowedClassifications.has(parsed.error.classification) ? parsed.error.classification : "external_unknown";
      if (parsed.error.deterministic === true) error.deterministic = true;
      throw error;
    }
    return assertIdentity(parsed, app, evidence?.buildNumber ? { buildNumber: evidence.buildNumber } : {});
  };

  const stageBuild = async ({ manifest, app, idempotencyKey, recordStage, beforeExternalOperation, afterExternalOperation }) => {
    let evidence = {};
    for (const [stage, mode] of [["test", "test"], ["archive", "archive"], ["upload", "upload"], ["processing", "processing"]]) {
      await recordStage(stage, minimalEvidence(evidence));
      evidence = { ...evidence, ...await run({ mode, manifest, app, idempotencyKey, evidence, beforeExternalOperation, afterExternalOperation }) };
      if (mode === "processing" && evidence.status === "absent" && evidence.authoritative === true) {
        throw new Error("App Store exact build is not yet visible after upload");
      }
    }
    if (!evidence.buildNumber || !evidence.uploadId || !evidence.processingId || evidence.processingStatus !== "processed") {
      throw typedFailure("App Store processing did not confirm the exact uploaded build", "validation");
    }
    return minimalEvidence(evidence);
  };

  const submitReview = async ({ manifest, app, build, idempotencyKey, recordStage, beforeExternalOperation, afterExternalOperation }) => {
    await recordStage("review_submit", minimalEvidence(build));
    let evidence = build;
    for (const mode of ["configure_version", "configure_review", "ensure_review", "ensure_review_item", "submit_review"]) {
      evidence = { ...evidence, ...await run({ mode, manifest, app, idempotencyKey, evidence, beforeExternalOperation, afterExternalOperation }) };
      await recordStage("review_submit", { ...minimalEvidence(evidence), observedEvidence: minimalEvidence(evidence) });
    }
    if (evidence.reviewConfigurationApplied !== true || evidence.automaticRelease !== true || !evidence.reviewSubmissionId) {
      throw typedFailure("App Store review submission did not confirm automatic release", "validation");
    }
    return minimalEvidence({ ...build, ...evidence });
  };

  const readReview = async ({ manifest, app, submission, idempotencyKey, recordStage, beforeExternalOperation, afterExternalOperation }) => {
    await recordStage("review_wait", minimalEvidence(submission));
    const evidence = await run({ mode: "read_review", manifest, app, idempotencyKey, evidence: submission, beforeExternalOperation, afterExternalOperation });
    if (evidence.status === "absent" && evidence.authoritative === true && evidence.submissionExists === false) {
      return minimalEvidence({ ...submission, ...evidence });
    }
    if (evidence.authoritative !== true || evidence.submissionExists !== true || evidence.automaticRelease !== true) {
      throw new Error("App Store review readback is not authoritative for the automatic submission");
    }
    if (evidence.reviewStatus === "rejected" || evidence.reviewStatus === "invalid") {
      throw typedFailure("App Store review rejected the submitted build", "product_rework");
    }
    return minimalEvidence({ ...submission, ...evidence });
  };

  const readLive = async ({ manifest, app, review, idempotencyKey, recordStage, beforeExternalOperation, afterExternalOperation }) => {
    await recordStage("release", minimalEvidence(review));
    const evidence = await run({ mode: "read_live", manifest, app, idempotencyKey, evidence: review, beforeExternalOperation, afterExternalOperation });
    await recordStage("live_readback", minimalEvidence(evidence));
    return minimalEvidence({ ...review, ...evidence });
  };

  return {
    stageBuild,
    submitReview,
    readReview,
    readLive,
    async release(context) {
      const build = await stageBuild(context);
      const submission = await submitReview({ ...context, build });
      const review = await readReview({ ...context, submission });
      if (review.status === "absent" && review.authoritative === true && review.submissionExists === false) {
        return { status: "absent", authoritative: true, evidence: review };
      }
      const lineage = Object.fromEntries(["externalRequestId", "buildNumber", "uploadId", "processingId", "reviewSubmissionId"].map((field) => [field, requiredString(review[field], field)]));
      return { ...review, lineage, observedEvidence: { lineage } };
    },
    async readback(context) {
      const { app } = context;
      let submission = context.submission ?? context.deployment ?? context.previous;
      if (!submission?.buildNumber) {
        await context.recordStage("test", { observedEvidence: { recovery: "before_upload" } });
        return { status: "absent", authoritative: true, evidence: { recovery: "before_upload" } };
      }
      if (!submission?.processingId) {
        await context.recordStage("processing", minimalEvidence(submission));
        const processed = await run({ ...context, mode: "processing", evidence: submission });
        if (processed.status === "absent" && processed.authoritative === true) {
          return { status: "absent", authoritative: true, evidence: processed };
        }
        submission = { ...submission, ...processed };
        await context.recordStage("processing", { ...minimalEvidence(submission), observedEvidence: minimalEvidence(submission) });
      }
      let review = await readReview({ ...context, submission });
      if (review.status === "absent" && review.authoritative === true && review.submissionExists === false) {
        review = await submitReview({ ...context, build: submission });
        const recoveredLineage = Object.fromEntries(["externalRequestId", "buildNumber", "uploadId", "processingId", "reviewSubmissionId"].map((field) => [field, requiredString(review[field], field)]));
        return { ...review, status: "waiting_external", authoritative: true, submissionExists: true, lineage: recoveredLineage, observedEvidence: minimalEvidence(review) };
      }
      const submittedLineage = { ...(submission?.lineage ?? submission?.observedEvidence?.lineage ?? submission), ...review };
      const baseLineage = Object.fromEntries(["externalRequestId", "buildNumber", "uploadId", "processingId", "reviewSubmissionId"].map((field) => [field, requiredString(submittedLineage?.[field], field)]));
      if (WAITING_REVIEW_STATES.has(review.reviewStatus) || review.reviewStatus === "submitted") {
        return { ...review, status: "waiting_external", authoritative: true, submissionExists: true, lineage: baseLineage, observedEvidence: minimalEvidence(review) };
      }
      if (review.reviewStatus !== "approved") throw new Error("App Store review state is not yet recognized as terminal or waiting");
      const live = await readLive({ ...context, review });
      const exact = live.authoritative === true
        && live.automaticRelease === true
        && live.releaseStatus === "released"
        && live.liveStatus === "live"
        && live.liveMarketingVersion === app.marketingVersion
        && live.liveBuildNumber === baseLineage.buildNumber
        && live.liveMembershipConfirmed === true;
      if (!exact && live.authoritative === true && live.liveStatus === "waiting") {
        return { ...live, status: "waiting_external", authoritative: true, submissionExists: true, lineage: baseLineage, observedEvidence: minimalEvidence(live) };
      }
      if (!exact) throw typedFailure("App Store live readback did not confirm the exact automatic-release build", "validation");
      const lineage = { ...baseLineage, reviewId: requiredString(live.reviewId, "reviewId"), releaseId: requiredString(live.releaseId, "releaseId"), liveId: requiredString(live.liveId, "liveId") };
      return { ...live, status: "completed", authoritative: true, lineage, observedEvidence: minimalEvidence(live), liveEvidence: { appStoreAppId: app.appStoreAppId, marketingVersion: app.marketingVersion, buildNumber: baseLineage.buildNumber, liveId: live.liveId, membershipConfirmed: true } };
    },
  };
}

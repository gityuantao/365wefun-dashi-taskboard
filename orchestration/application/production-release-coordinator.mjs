import { isDeepStrictEqual } from "node:util";

import { DomainError } from "../domain/errors.mjs";
import { sanitizeObservedEvidenceString } from "../domain/redaction.mjs";
import { enabledIosApps, loadIosApps } from "../ios/app-registry.mjs";
import { assertProductionPlatformsSupported } from "../release/platform-gate.mjs";
import {
  acquireProductionReleaseLease,
  beginProductionTarget,
  completeProductionReleaseAttempt,
  countProductionTargetSafeReposts,
  failProductionReleaseAttempt,
  failureFingerprint,
  initializeProductionTargets,
  listProductionTargetKeys,
  listReusableProductionTargetSuccesses,
  loadLatestProductionTarget,
  openProductionReleaseAttempt,
  releaseProductionReleaseLease,
  renewProductionReleaseLease,
  targetFailureValues,
  updateProductionTarget,
} from "./production-release-store.mjs";

function invalid(message) {
  throw new DomainError("INVALID_PRODUCTION_RELEASE", message);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function sanitizeEvidenceValue(value) {
  if (typeof value === "string") return sanitizeObservedEvidenceString(value);
  if (Array.isArray(value)) return value.map(sanitizeEvidenceValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      sanitizeObservedEvidenceString(key), sanitizeEvidenceValue(child),
    ]));
  }
  return value;
}

function sanitizeAdapterResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw postEffectContractFailure("production release adapter returned invalid evidence");
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (sanitizeObservedEvidenceString(key) !== key) {
      throw postEffectContractFailure("production release adapter returned an unsafe evidence field");
    }
    if (/evidence/i.test(key)) {
      result[key] = sanitizeEvidenceValue(child);
      continue;
    }
    if (typeof child === "string" && sanitizeObservedEvidenceString(child) !== child) {
      throw postEffectContractFailure(`production release adapter returned unsafe ${key}`);
    }
    if (child && typeof child === "object") {
      result[key] = sanitizeAdapterResponse(child);
      continue;
    }
    result[key] = child;
  }
  return result;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") invalid("frozen manifest is required");
  for (const field of ["versionId", "candidateCommit", "checksum"]) {
    if (!nonEmpty(manifest[field])) invalid(`frozen manifest ${field} is required`);
  }
}

function validateAdapter(adapter, name) {
  if (
    adapter === null
    || typeof adapter !== "object"
    || adapter.placeholder === true
    || typeof adapter.release !== "function"
    || typeof adapter.readback !== "function"
  ) {
    invalid(`${name} production release adapter is not configured`);
  }
}

function validationFailure(message) {
  const error = new Error(message);
  error.deterministic = true;
  error.failureClassification = "validation";
  return error;
}

function postEffectContractFailure(message) {
  const error = new Error(message);
  error.failureClassification = "external_unknown";
  return error;
}

function enabledApps(apps) {
  if (!Array.isArray(apps)) invalid("iOS production App registry must be an array");
  const originals = new Map(apps.map((app) => [app?.id, app]));
  return enabledIosApps(loadIosApps(apps)).map((app) => ({
    ...app,
    marketingVersion: originals.get(app.id)?.marketingVersion,
  }));
}

function validateApp(app) {
  for (const field of ["id", "appStoreAppId", "bundleId", "marketingVersion"]) {
    if (!nonEmpty(app?.[field])) invalid(`iOS production App ${field} is required`);
  }
}

function targetKey(platform, appId = "") {
  return `${platform}:${appId}`;
}

function targetDescriptor(platform, app = null) {
  return { platform, app, appId: app?.id ?? "" };
}

function samePersistedTargetIdentity(descriptor, target) {
  if (!target || target.platform !== descriptor.platform || target.appId !== descriptor.appId) {
    return false;
  }
  return descriptor.platform !== "ios" || (
    target.appStoreAppId === descriptor.app.appStoreAppId
    && target.bundleId === descriptor.app.bundleId
    && target.marketingVersion === descriptor.app.marketingVersion
  );
}

function requiredTargets(platforms, apps) {
  const targets = [];
  if (platforms.web) targets.push(targetDescriptor("web"));
  if (platforms.api) targets.push(targetDescriptor("api"));
  if (platforms.ios) {
    for (const app of enabledApps(apps)) {
      validateApp(app);
      targets.push(targetDescriptor("ios", app));
    }
    if (!targets.some((target) => target.platform === "ios")) {
      invalid("iOS production release requires at least one enabled App");
    }
  }
  return targets;
}

function currentLeaseTime(now, leaseOptions) {
  return typeof leaseOptions?.now === "function"
    ? leaseOptions.now()
    : new Date().toISOString();
}

async function fencedExternalEffect({ db, activeLease, leaseOptions, now }, operation) {
  const guard = async () => {
    if (typeof leaseOptions?.beforeExternalOperation === "function") {
      await leaseOptions.beforeExternalOperation();
    }
    await renewProductionReleaseLease({
      db,
      lease: activeLease,
      now: currentLeaseTime(now, leaseOptions),
    });
  };
  await guard();
  let result;
  let operationError;
  try {
    result = await operation({
      beforeExternalOperation: guard,
      afterExternalOperation: guard,
    });
  } catch (error) {
    operationError = error;
  }
  await guard();
  if (operationError) throw operationError;
  return result;
}

function releaseValues(target, response) {
  if (!response || typeof response !== "object") {
    throw postEffectContractFailure("production release adapter returned no submission evidence");
  }
  if (!nonEmpty(response.externalRequestId)) {
    throw postEffectContractFailure("production release adapter omitted externalRequestId");
  }
  if (target.platform === "ios" && !nonEmpty(response.buildNumber)) {
    throw postEffectContractFailure("iOS production release adapter omitted buildNumber");
  }
  if (target.platform === "ios") {
    const requiredLineage = [
      "externalRequestId", "buildNumber", "uploadId", "processingId", "reviewSubmissionId",
    ];
    if (
      !response.lineage
      || requiredLineage.some((field) => !nonEmpty(response.lineage[field]))
      || requiredLineage.some((field) => response.lineage[field] !== response[field])
    ) {
      throw postEffectContractFailure("iOS production release adapter omitted exact submission lineage");
    }
  }
  return {
    stage: target.platform === "ios" ? "review_wait" : "readback",
    status: "running",
    externalRequestId: response.externalRequestId,
    reconciliationStatus: "pending_readback",
    artifactIdentity: response.artifactIdentity ?? target.artifactIdentity,
    productionReleaseId: response.productionReleaseId ?? target.productionReleaseId,
    buildNumber: response.buildNumber ?? target.buildNumber,
    processingStatus: response.processingStatus ?? target.processingStatus,
    processingId: response.processingId ?? target.processingId,
    reviewStatus: response.reviewStatus ?? target.reviewStatus,
    reviewSubmissionId: response.reviewSubmissionId ?? target.reviewSubmissionId,
    uploadId: response.uploadId ?? target.uploadId,
    reviewId: response.reviewId ?? target.reviewId,
    releaseStatus: response.releaseStatus ?? target.releaseStatus,
    releaseId: response.releaseId ?? target.releaseId,
    liveStatus: response.liveStatus ?? target.liveStatus,
    observedEvidence: target.platform === "ios"
      ? {
        ...(response.observedEvidence ?? response.evidence ?? {}),
        lineage: response.lineage,
      }
      : response.observedEvidence ?? response.evidence ?? target.observedEvidence,
  };
}

function webSuccessValues({ manifest, target, observed }) {
  const externalRequestId = observed?.externalRequestId
    ?? target.externalRequestId;
  if (
    observed?.status === "waiting_external"
    || observed?.published !== true
    || !["published", "live"].includes(observed?.status)
    || observed?.authoritative !== true
    || observed?.confirmed !== true
    || observed?.candidateCommit !== manifest.candidateCommit
    || !isDeepStrictEqual(observed?.artifactIdentity, manifest.artifactIdentity)
    || !nonEmpty(externalRequestId)
    || !nonEmpty(observed?.productionReleaseId)
    || observed?.healthStatus !== "healthy"
    || observed?.readbackStatus !== "confirmed"
    || observed?.observedEvidence === null
    || observed?.observedEvidence === undefined
    || observed?.readbackEvidence === null
    || observed?.readbackEvidence === undefined
  ) {
    return null;
  }
  return {
    stage: "readback",
    status: "succeeded",
    externalRequestId,
    reconciliationStatus: "readback_confirmed",
    artifactIdentity: observed.artifactIdentity,
    productionReadbackSha: observed.candidateCommit,
    productionReleaseId: observed.productionReleaseId,
    healthStatus: "healthy",
    readbackStatus: "confirmed",
    observedEvidence: observed.observedEvidence,
    readbackEvidence: {
      evidence: observed.readbackEvidence,
      publication: observed,
    },
  };
}

function iosSuccessValues({ app, target, observed }) {
  const buildNumber = observed?.buildNumber;
  const externalRequestId = observed?.externalRequestId;
  const submittedLineage = target.observedEvidence?.lineage;
  const liveLineage = observed?.lineage;
  const submissionFields = [
    "externalRequestId", "buildNumber", "uploadId", "processingId", "reviewSubmissionId",
  ];
  const terminalFields = ["reviewId", "releaseId", "liveId"];
  const exactLineage = submittedLineage != null
    && liveLineage != null
    && submissionFields.every((field) => nonEmpty(liveLineage[field]))
    && submissionFields.every((field) => liveLineage[field] === submittedLineage[field])
    && [...submissionFields, ...terminalFields].every(
      (field) => nonEmpty(liveLineage[field]) && liveLineage[field] === observed?.[field],
    );
  const authoritativeLiveProof = observed?.liveMembershipConfirmed === true || (
    observed?.liveEvidence?.membershipConfirmed === true
    && observed.liveEvidence.appStoreAppId === app.appStoreAppId
    && observed.liveEvidence.marketingVersion === app.marketingVersion
    && observed.liveEvidence.buildNumber === observed.buildNumber
    && observed.liveEvidence.liveId === observed.liveId
  );
  const success = observed?.status === "completed"
    && observed?.authoritative === true
    && exactLineage
    && nonEmpty(externalRequestId)
    && nonEmpty(buildNumber)
    && nonEmpty(observed?.uploadId)
    && observed?.processingStatus === "processed"
    && nonEmpty(observed?.processingId)
    && observed?.reviewStatus === "approved"
    && nonEmpty(observed?.reviewSubmissionId)
    && nonEmpty(observed?.reviewId)
    && observed?.releaseStatus === "released"
    && nonEmpty(observed?.releaseId)
    && observed?.liveStatus === "live"
    && nonEmpty(observed?.liveId)
    && observed?.liveMarketingVersion === app.marketingVersion
    && observed?.liveBuildNumber === buildNumber
    && authoritativeLiveProof
    && observed?.observedEvidence != null;
  if (!success) return null;
  return {
    stage: "live_readback",
    status: "succeeded",
    externalRequestId,
    reconciliationStatus: "readback_confirmed",
    buildNumber,
    processingStatus: observed.processingStatus,
    processingId: observed.processingId,
    reviewStatus: observed.reviewStatus,
    reviewSubmissionId: observed.reviewSubmissionId,
    uploadId: observed.uploadId,
    reviewId: observed.reviewId,
    releaseStatus: observed.releaseStatus,
    releaseId: observed.releaseId,
    liveStatus: observed.liveStatus,
    liveId: observed.liveId,
    liveMarketingVersion: observed.liveMarketingVersion,
    liveBuildNumber: observed.liveBuildNumber,
    liveMembershipConfirmed: observed.liveMembershipConfirmed ?? null,
    observedEvidence: {
      ...observed.observedEvidence,
      authoritative: true,
      lineage: liveLineage,
    },
    liveEvidence: observed.liveEvidence ?? null,
  };
}

function waitingValues(target, observed) {
  const buildNumber = observed?.buildNumber ?? target.buildNumber;
  const preBuildStage = target.stage === "archive" ? "archive" : "test";
  const iosStage = nonEmpty(buildNumber)
    ? ["test", "archive"].includes(target.stage) ? "processing" : target.stage
    : preBuildStage;
  return {
    stage: target.platform === "ios" ? iosStage : "readback",
    status: "running",
    externalRequestId: observed?.externalRequestId ?? target.externalRequestId,
    reconciliationStatus: "pending_readback",
    buildNumber,
    processingStatus: observed?.processingStatus ?? target.processingStatus,
    processingId: observed?.processingId ?? target.processingId,
    reviewStatus: observed?.reviewStatus ?? target.reviewStatus,
    reviewSubmissionId: observed?.reviewSubmissionId ?? target.reviewSubmissionId,
    uploadId: observed?.uploadId ?? target.uploadId,
    releaseStatus: observed?.releaseStatus ?? target.releaseStatus,
    liveStatus: observed?.liveStatus ?? target.liveStatus,
    observedEvidence: target.platform === "ios" && target.observedEvidence?.lineage
      ? {
        ...(observed?.observedEvidence ?? {}),
        lineage: target.observedEvidence.lineage,
      }
      : observed?.observedEvidence ?? target.observedEvidence,
    readbackEvidence: observed?.readbackEvidence ?? target.readbackEvidence,
  };
}

function observationValues(previous) {
  const hasIosBuild = previous.platform === "ios" && nonEmpty(previous.buildNumber);
  return {
    stage: previous.platform === "ios"
      ? hasIosBuild ? "review_wait" : "test"
      : "readback",
    status: "running",
    externalRequestId: previous.externalRequestId,
    reconciliationStatus: "pending_readback",
    artifactIdentity: previous.artifactIdentity,
    productionReleaseId: previous.productionReleaseId,
    buildNumber: previous.buildNumber,
    processingStatus: previous.processingStatus,
    processingId: previous.processingId,
    reviewStatus: previous.reviewStatus,
    reviewSubmissionId: previous.reviewSubmissionId,
    uploadId: previous.uploadId,
    reviewId: previous.reviewId,
    releaseStatus: previous.releaseStatus,
    releaseId: previous.releaseId,
    liveStatus: previous.liveStatus,
    observedEvidence: previous.observedEvidence,
    readbackEvidence: previous.readbackEvidence,
  };
}

function deterministicFailure(error) {
  return error?.deterministic === true;
}

function deterministicReadbackFailure(descriptor, observed) {
  if (descriptor.platform === "ios" && observed?.reviewStatus === "rejected") {
    const error = new Error("App Store review rejected the submitted build");
    error.deterministic = true;
    error.failureClassification = "product_rework";
    return error;
  }
  if (observed?.status === "failed" || observed?.readbackStatus === "mismatch") {
    const error = new Error("Candidate readback did not confirm the exact frozen Candidate and artifact");
    error.deterministic = true;
    error.failureClassification = "validation";
    return error;
  }
  if (observed?.status === "completed" || observed?.confirmed === true) {
    const error = new Error("Candidate readback did not confirm the exact frozen Candidate and artifact");
    error.deterministic = true;
    error.failureClassification = "validation";
    return error;
  }
  return null;
}

function failureResult(target, values) {
  return {
    status: "failed",
    target: {
      platform: target.platform,
      appId: target.appId,
      stage: target.stage,
      status: "failed",
      failureClassification: values.failureClassification,
      failureFingerprint: values.failureFingerprint,
      error: values.sanitizedErrorSummary,
    },
  };
}

function aggregatePublication(manifest, targets, publications = []) {
  const webPublication = publications.find((publication) => (
    publication?.published === true
    && ["published", "live"].includes(publication?.status)
    && publication?.candidateCommit === manifest.candidateCommit
  ));
  if (webPublication) return webPublication;
  const iosTargets = targets.filter((target) => target.platform === "ios");
  if (iosTargets.length > 0 && iosTargets.every((target) => (
    target.status === "succeeded"
    && target.liveStatus === "live"
    && nonEmpty(target.liveId)
    && nonEmpty(target.releaseId)
  ))) {
    return {
      kind: "ios_aggregate",
      status: "live",
      confirmed: true,
      published: true,
      candidateCommit: manifest.candidateCommit,
      manifestChecksum: manifest.checksum,
      cleanupToken: `ios:${manifest.checksum}:${iosTargets.map((target) => target.liveId).join(":")}`,
      targets: iosTargets.map((target) => ({
        appId: target.appId,
        appStoreAppId: target.appStoreAppId,
        marketingVersion: target.liveMarketingVersion,
        buildNumber: target.liveBuildNumber,
        releaseId: target.releaseId,
        liveId: target.liveId,
      })),
    };
  }
  return null;
}

async function executeTarget({
  db,
  manifest,
  descriptor,
  adapter,
  activeLease,
  leaseOptions,
  now,
  forceSubmission = false,
}) {
  let target = await loadLatestProductionTarget({
    db,
    manifest,
    platform: descriptor.platform,
    appId: descriptor.appId,
  });
  const requiresRecoveryReadback = !forceSubmission && target !== null
    && target.status !== "succeeded"
    && (
      target.status === "running"
      || target.reconciliationStatus === "unknown_outcome"
      || target.reconciliationStatus === "pending_readback"
      || (
        target.failureClassification === "external_unknown"
        && target.reconciliationStatus === "readback_mismatch"
      )
    );
  let submission = target;
  const recordedStages = [];
  const recordStage = async (stage, evidence = {}) => {
    if (target.platform === "ios") {
      for (const field of ["buildNumber", "uploadId", "processingId", "reviewSubmissionId"]) {
        if (nonEmpty(target[field]) && nonEmpty(evidence[field]) && target[field] !== evidence[field]) {
          throw validationFailure(`iOS production release ${field} lineage changed during ${stage}`);
        }
      }
    }
    const nextObservedEvidence = evidence.observedEvidence ?? evidence.evidence;
    target = await updateProductionTarget({
      db,
      target,
      values: {
        ...evidence,
        stage,
        observedEvidence: nextObservedEvidence == null
          ? target.observedEvidence
          : { ...(target.observedEvidence ?? {}), ...nextObservedEvidence },
      },
      lease: activeLease,
      leaseNow: currentLeaseTime(now, leaseOptions),
      now,
    });
    recordedStages.push(stage);
  };
  const idempotencyKeyFor = (attempt) => (
    `${manifest.versionId}:${manifest.checksum}:${descriptor.platform}:${descriptor.appId}:${attempt}`
  );

  if (!requiresRecoveryReadback) {
    if (!target || target.status === "failed") {
      target = await beginProductionTarget({
        db,
        manifest,
        platform: descriptor.platform,
        app: descriptor.app,
        lease: activeLease,
        leaseNow: currentLeaseTime(now, leaseOptions),
        now,
      });
    } else {
      target = await updateProductionTarget({
        db,
        target,
        values: { status: "running" },
        lease: activeLease,
        leaseNow: currentLeaseTime(now, leaseOptions),
        now,
      });
    }
    try {
      submission = sanitizeAdapterResponse(await fencedExternalEffect(
        { db, activeLease, leaseOptions, now },
        (fencing) => adapter.release({
          manifest,
          platform: descriptor.platform,
          app: descriptor.app,
          idempotencyKey: idempotencyKeyFor(target.attempt),
          recordStage,
          ...fencing,
        }),
      ));
      const distinctRecordedStages = recordedStages.filter((stage, index) => index === 0 || recordedStages[index - 1] !== stage);
      if (descriptor.platform === "ios" && !isDeepStrictEqual(distinctRecordedStages, [
        "test", "archive", "upload", "processing", "review_submit", "review_wait",
      ])) {
        throw postEffectContractFailure("iOS production release adapter omitted the mandatory staged lifecycle");
      }
      if (descriptor.platform === "ios") {
        for (const field of [
          "externalRequestId", "buildNumber", "uploadId", "processingId", "reviewSubmissionId",
        ]) {
          if (nonEmpty(target[field]) && target[field] !== submission.lineage?.[field]) {
            throw postEffectContractFailure(`iOS production release ${field} did not match staged lineage`);
          }
        }
      }
      target = await updateProductionTarget({
        db,
        target,
        values: releaseValues(target, submission),
        lease: activeLease,
        leaseNow: currentLeaseTime(now, leaseOptions),
        now,
      });
    } catch (error) {
      if (error?.code === "PRODUCTION_RELEASE_LEASE_LOST") throw error;
      const reconciliationStatus = deterministicFailure(error) ? "not_required" : "unknown_outcome";
      const values = targetFailureValues({
        target,
        error,
        classification: error?.failureClassification
          ?? (deterministicFailure(error) ? "validation" : "external_unknown"),
        reconciliationStatus,
        now,
      });
      if (!deterministicFailure(error) && submission && typeof submission === "object") {
        values.externalRequestId = submission.externalRequestId ?? target.externalRequestId;
        values.artifactIdentity = submission.artifactIdentity ?? target.artifactIdentity;
        values.productionReleaseId = submission.productionReleaseId ?? target.productionReleaseId;
        values.buildNumber = submission.buildNumber ?? target.buildNumber;
        values.observedEvidence = submission.observedEvidence ?? submission.evidence ?? target.observedEvidence;
      }
      target = await updateProductionTarget({
        db,
        target,
        values,
        lease: activeLease,
        leaseNow: currentLeaseTime(now, leaseOptions),
        now,
      });
      if (!deterministicFailure(error)) {
        return { status: "waiting_external", target };
      }
      return failureResult(target, values);
    }
  } else {
    const previous = target;
    target = await beginProductionTarget({
      db,
      manifest,
      platform: descriptor.platform,
      app: descriptor.app,
      reconciliationStatus: "pending_readback",
      lease: activeLease,
      leaseNow: currentLeaseTime(now, leaseOptions),
      now,
    });
    target = await updateProductionTarget({
      db,
      target,
      values: observationValues(previous),
      lease: activeLease,
      leaseNow: currentLeaseTime(now, leaseOptions),
      now,
    });
  }

  let observed;
  recordedStages.length = 0;
  try {
    observed = sanitizeAdapterResponse(await fencedExternalEffect(
      { db, activeLease, leaseOptions, now },
      (fencing) => adapter.readback({
        manifest,
        platform: descriptor.platform,
        app: descriptor.app,
        deployment: submission,
        submission,
        previous: target,
        readbackLocator: submission?.observedEvidence ?? submission,
        externalRequestId: submission?.externalRequestId ?? null,
        idempotencyKey: idempotencyKeyFor(submission?.attempt ?? target.attempt),
        recordStage,
        ...fencing,
      }),
    ));
    if (descriptor.platform === "ios" && recordedStages.length === 0) {
      throw validationFailure("iOS production release readback omitted a fenced stage");
    }
  } catch (error) {
    if (error?.code === "PRODUCTION_RELEASE_LEASE_LOST") throw error;
    const maxReconciliationAttempts = Number(leaseOptions?.maxReconciliationAttempts ?? 3);
    if (
      Number.isInteger(maxReconciliationAttempts)
      && maxReconciliationAttempts > 0
      && target.attempt >= maxReconciliationAttempts
    ) {
      const values = targetFailureValues({
        target,
        error,
        classification: "external_unknown",
        reconciliationStatus: "readback_mismatch",
        now,
      });
      target = await updateProductionTarget({
        db,
        target,
        values,
        lease: activeLease,
        leaseNow: currentLeaseTime(now, leaseOptions),
        now,
      });
      return failureResult(target, values);
    }
    target = await updateProductionTarget({
      db,
      target,
      values: {
        ...waitingValues(target, null),
        sanitizedErrorSummary: String(error?.message ?? error).slice(0, 1024),
      },
      lease: activeLease,
      leaseNow: currentLeaseTime(now, leaseOptions),
      now,
    });
    return { status: "waiting_external", target };
  }

  if (observed?.status === "absent" && observed?.authoritative === true) {
    const safeReposts = await countProductionTargetSafeReposts({
      db,
      manifest,
      platform: descriptor.platform,
      appId: descriptor.appId,
    });
    const maxSafeReposts = Number(leaseOptions?.maxSafeReposts ?? 1);
    if (Number.isInteger(maxSafeReposts) && maxSafeReposts > 0 && safeReposts < maxSafeReposts) {
      const absentError = new Error("authoritative production readback confirmed absence; safe repost authorized");
      const values = targetFailureValues({
        target,
        error: absentError,
        classification: "external_unknown",
        reconciliationStatus: "readback_mismatch",
        now,
      });
      target = await updateProductionTarget({
        db,
        target,
        values: {
          ...values,
          observedEvidence: {
            safeRepostAuthorized: true,
            authoritativeAbsence: observed.evidence ?? observed,
          },
        },
        lease: activeLease,
        leaseNow: currentLeaseTime(now, leaseOptions),
        now,
      });
      return executeTarget({
        db,
        manifest,
        descriptor,
        adapter,
        activeLease,
        leaseOptions,
        now,
        forceSubmission: true,
      });
    }
    const exhausted = new Error("authoritative absence safe repost budget exhausted");
    const values = targetFailureValues({
      target,
      error: exhausted,
      classification: "external_unknown",
      reconciliationStatus: "readback_mismatch",
      now,
    });
    target = await updateProductionTarget({
      db, target, values, lease: activeLease,
      leaseNow: currentLeaseTime(now, leaseOptions), now,
    });
    return failureResult(target, values);
  }

  const terminalValues = descriptor.platform === "ios"
    ? iosSuccessValues({ app: descriptor.app, target, observed })
    : webSuccessValues({ manifest, target, observed });
  if (terminalValues) {
    target = await updateProductionTarget({
      db,
      target,
      values: { ...terminalValues, completedAt: now },
      lease: activeLease,
      leaseNow: currentLeaseTime(now, leaseOptions),
      now,
    });
    return { status: "completed", target, publication: observed };
  }
  const readbackFailure = deterministicReadbackFailure(descriptor, observed);
  if (readbackFailure) {
    const values = targetFailureValues({
      target,
      error: readbackFailure,
      classification: readbackFailure.failureClassification,
      reconciliationStatus: "readback_mismatch",
      now,
    });
    target = await updateProductionTarget({
      db,
      target,
      values,
      lease: activeLease,
      leaseNow: currentLeaseTime(now, leaseOptions),
      now,
    });
    return failureResult(target, values);
  }
  const waitingLineage = observed?.lineage;
  const submittedLineage = target.observedEvidence?.lineage;
  const confirmedAppleWaiting = descriptor.platform === "ios"
    && observed?.status === "waiting_external"
    && observed?.authoritative === true
    && observed?.submissionExists === true
    && nonEmpty(target.externalRequestId)
    && nonEmpty(target.buildNumber)
    && submittedLineage != null
    && waitingLineage != null
    && ["externalRequestId", "buildNumber", "uploadId", "processingId", "reviewSubmissionId"].every(
      (field) => waitingLineage[field] === submittedLineage[field],
    );
  const maxReconciliationAttempts = Number(leaseOptions?.maxReconciliationAttempts ?? 3);
  if (
    !confirmedAppleWaiting
    && Number.isInteger(maxReconciliationAttempts)
    && maxReconciliationAttempts > 0
    && target.attempt >= maxReconciliationAttempts
  ) {
    const exhausted = new Error("production readback reconciliation budget exhausted");
    const values = targetFailureValues({
      target,
      error: exhausted,
      classification: "external_unknown",
      reconciliationStatus: "readback_mismatch",
      now,
    });
    target = await updateProductionTarget({
      db, target, values, lease: activeLease,
      leaseNow: currentLeaseTime(now, leaseOptions), now,
    });
    return failureResult(target, values);
  }
  target = await updateProductionTarget({
    db,
    target,
    values: waitingValues(target, observed),
    lease: activeLease,
    leaseNow: currentLeaseTime(now, leaseOptions),
    now,
  });
  return { status: "waiting_external", target };
}

export async function executeProductionRelease({
  db,
  manifest,
  platforms,
  apps = [],
  webAdapter,
  iosAdapter,
  lease,
  now,
}) {
  validateManifest(manifest);
  const resolvedPlatforms = assertProductionPlatformsSupported(platforms);
  const descriptors = requiredTargets(resolvedPlatforms, apps);
  if (resolvedPlatforms.web || resolvedPlatforms.api) validateAdapter(webAdapter, "Web/API");
  if (resolvedPlatforms.ios) validateAdapter(iosAdapter, "iOS");
  if (!lease || !nonEmpty(lease.holder)) invalid("version-scoped release lease holder is required");

  let activeLease;
  try {
    activeLease = await acquireProductionReleaseLease({
      db,
      versionId: manifest.versionId,
      holder: lease.holder,
      durationMs: lease.durationMs,
      now: currentLeaseTime(now, lease),
    });
  } catch (error) {
    if (error?.code !== "PRODUCTION_RELEASE_LEASE_LOST") throw error;
    return { status: "waiting_external", targets: [], error: error.message };
  }

  let releaseAttempt;
  try {
    releaseAttempt = await openProductionReleaseAttempt({
      db,
      manifest,
      lease: activeLease,
      leaseNow: currentLeaseTime(now, lease),
      now,
    });
    const expectedTargetKeys = new Set(
      descriptors.map((descriptor) => targetKey(descriptor.platform, descriptor.appId)),
    );
    let persistedTargetKeys = await listProductionTargetKeys({ db, manifest });
    if (persistedTargetKeys.size === 0 && releaseAttempt.status !== "succeeded") {
      await initializeProductionTargets({
        db,
        manifest,
        targets: descriptors,
        lease: activeLease,
        leaseNow: currentLeaseTime(now, lease),
        now,
      });
      persistedTargetKeys = await listProductionTargetKeys({ db, manifest });
    }
    if (
      persistedTargetKeys.size !== expectedTargetKeys.size
      || [...expectedTargetKeys].some((key) => !persistedTargetKeys.has(key))
    ) {
      invalid("persisted production target scope does not match the frozen manifest identity");
    }
    for (const descriptor of descriptors) {
      const persisted = await loadLatestProductionTarget({
        db,
        manifest,
        platform: descriptor.platform,
        appId: descriptor.appId,
      });
      if (!samePersistedTargetIdentity(descriptor, persisted)) {
        invalid("persisted production target identity does not match the frozen release target");
      }
    }
    const reusable = await listReusableProductionTargetSuccesses({ db, manifest });
    if (releaseAttempt.status === "succeeded") {
      const missing = descriptors.filter(
        (descriptor) => !reusable.has(targetKey(descriptor.platform, descriptor.appId)),
      );
      if (missing.length > 0 || reusable.size !== descriptors.length) {
        invalid("terminal release attempt target scope does not match the frozen manifest identity");
      }
      return {
        status: "completed",
        targets: descriptors.map((descriptor) => ({
          ...reusable.get(targetKey(descriptor.platform, descriptor.appId)),
          reused: true,
        })),
        publication: aggregatePublication(
          manifest,
          [...reusable.values()],
          [...reusable.values()].map((target) => target.readbackEvidence?.publication).filter(Boolean),
        ),
      };
    }
    const results = [];
    const publications = [];
    for (const descriptor of descriptors) {
      const reused = reusable.get(targetKey(descriptor.platform, descriptor.appId));
      if (reused) {
        results.push({ ...reused, reused: true });
        continue;
      }
      let executed;
      try {
        executed = await executeTarget({
          db,
          manifest,
          descriptor,
          adapter: descriptor.platform === "ios" ? iosAdapter : webAdapter,
          activeLease,
          leaseOptions: lease,
          now,
        });
      } catch (error) {
        if (error?.code !== "PRODUCTION_RELEASE_LEASE_LOST") throw error;
        return { status: "waiting_external", targets: results, error: error.message };
      }
      results.push({ ...executed.target, reused: false });
      if (executed.publication) publications.push(executed.publication);
      if (executed.status === "waiting_external") {
        return { status: "waiting_external", targets: results };
      }
      if (executed.status === "failed") {
        await failProductionReleaseAttempt({
          db,
          manifest,
          attempt: releaseAttempt.attempt,
          fingerprint: executed.target.failureFingerprint,
          lease: activeLease,
          leaseNow: currentLeaseTime(now, lease),
          now,
        });
        return {
          status: "failed",
          targets: results,
          error: executed.target.error,
          failureFingerprint: executed.target.failureFingerprint,
        };
      }
    }
    if (releaseAttempt.status !== "succeeded") {
      await completeProductionReleaseAttempt({
        db,
        manifest,
        attempt: releaseAttempt.attempt,
        lease: activeLease,
        leaseNow: currentLeaseTime(now, lease),
        now,
      });
    }
    for (const target of results) {
      const persisted = target.readbackEvidence?.publication;
      if (persisted) publications.push(persisted);
    }
    return {
      status: "completed",
      targets: results,
      publication: aggregatePublication(manifest, results, publications),
    };
  } catch (error) {
    if (error?.code === "PRODUCTION_RELEASE_LEASE_LOST") {
      return { status: "waiting_external", targets: [], error: error.message };
    }
    if (releaseAttempt?.status === "running") {
      const fingerprint = failureFingerprint(
        manifest.versionId,
        manifest.candidateCommit,
        manifest.checksum,
        "coordinator",
        error?.message ?? error,
      );
      try {
        await failProductionReleaseAttempt({
          db,
          manifest,
          attempt: releaseAttempt.attempt,
          fingerprint,
          lease: activeLease,
          leaseNow: currentLeaseTime(now, lease),
          now,
        });
      } catch (failureError) {
        if (failureError?.code === "PRODUCTION_RELEASE_LEASE_LOST") {
          return { status: "waiting_external", targets: [], error: failureError.message };
        }
        throw failureError;
      }
    }
    throw error;
  } finally {
    await releaseProductionReleaseLease({
      db,
      lease: activeLease,
      now: currentLeaseTime(now, lease),
    });
  }
}

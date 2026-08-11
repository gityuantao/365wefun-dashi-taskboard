import { createHash } from "node:crypto";

import { redactCredentials } from "../domain/redaction.mjs";

const DEFAULT_RELEASE_LEASE_MS = 10 * 60_000;

function releaseLeaseId(versionId) {
  return `production-release:${versionId}`;
}

function expiresAt(now, durationMs) {
  return new Date(Date.parse(now) + durationMs).toISOString();
}

function nonEmpty(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`production release ${field} must be a non-empty string`);
  }
  return value;
}

function changes(result) {
  return Number(result?.meta?.changes ?? 0);
}

function leaseLost(versionId) {
  const error = new Error(`production release lease for ${versionId} was lost`);
  error.code = "PRODUCTION_RELEASE_LEASE_LOST";
  return error;
}

function transitionConflict(kind, versionId) {
  const error = new Error(`production release ${kind} transition conflicted for ${versionId}`);
  error.code = "PRODUCTION_RELEASE_TRANSITION_CONFLICT";
  return error;
}

async function assertLeaseCurrent({ db, lease, now }) {
  const current = await db.prepare(
    `SELECT 1 AS current FROM orchestration_leases
     WHERE id = ? AND aggregate_type = 'version' AND aggregate_id = ?
       AND holder = ? AND fencing_token = ? AND expires_at > ?`,
  ).bind(
    lease.id,
    lease.versionId,
    lease.holder,
    lease.fencingToken,
    now,
  ).first();
  if (!current) throw leaseLost(lease.versionId);
}

function jsonEvidence(value) {
  if (value === null || value === undefined) return null;
  const serialized = redactCredentials(JSON.stringify(value));
  if (serialized.length <= 4096) return serialized;
  return JSON.stringify({ truncated: true, sha256: failureFingerprint(serialized) });
}

function artifactIdentity(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? nonEmpty(value, "artifact identity") : JSON.stringify(value);
}

function errorSummary(value) {
  const summary = redactCredentials(value?.message ?? value ?? "unknown production release error")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1024);
  return summary || "unknown production release error";
}

function parseJson(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function mapAttempt(row) {
  if (!row) return null;
  return {
    versionId: row.version_id,
    candidateCommit: row.candidate_commit,
    manifestChecksum: row.manifest_checksum,
    attempt: Number(row.attempt),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    failureFingerprint: row.failure_fingerprint,
  };
}

function mapTarget(row) {
  if (!row) return null;
  return {
    versionId: row.version_id,
    candidateCommit: row.candidate_commit,
    manifestChecksum: row.manifest_checksum,
    platform: row.platform,
    appId: row.app_id,
    attempt: Number(row.attempt),
    stage: row.stage,
    status: row.status,
    externalRequestId: row.external_request_id,
    reconciliationStatus: row.reconciliation_status,
    failureClassification: row.failure_classification,
    sanitizedErrorSummary: row.sanitized_error_summary,
    artifactIdentity: parseJson(row.artifact_identity),
    productionReadbackSha: row.production_readback_sha,
    productionReleaseId: row.production_release_id,
    healthStatus: row.health_status,
    readbackStatus: row.readback_status,
    appStoreAppId: row.app_store_app_id,
    bundleId: row.bundle_id,
    marketingVersion: row.marketing_version,
    buildNumber: row.build_number,
    processingStatus: row.processing_status,
    processingId: row.processing_id,
    reviewStatus: row.review_status,
    reviewSubmissionId: row.review_submission_id,
    uploadId: row.upload_id,
    reviewId: row.review_id,
    releaseStatus: row.release_status,
    releaseId: row.release_id,
    liveStatus: row.live_status,
    liveId: row.live_id,
    liveMarketingVersion: row.live_marketing_version,
    liveBuildNumber: row.live_build_number,
    liveMembershipConfirmed: row.live_membership_confirmed === null
      ? null
      : row.live_membership_confirmed === 1,
    observedEvidence: parseJson(row.sanitized_observed_evidence),
    readbackEvidence: parseJson(row.sanitized_readback_evidence),
    liveEvidence: parseJson(row.sanitized_live_evidence),
    failureFingerprint: row.failure_fingerprint,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const TARGET_COLUMNS = `
  version_id, candidate_commit, manifest_checksum, platform, app_id, attempt,
  stage, status, external_request_id, reconciliation_status,
  failure_classification, sanitized_error_summary, artifact_identity,
  production_readback_sha, production_release_id, health_status, readback_status,
  app_store_app_id, bundle_id, marketing_version, build_number,
  processing_status, processing_id, review_status, review_submission_id,
  upload_id, review_id, release_status, release_id, live_status, live_id,
  live_marketing_version, live_build_number, live_membership_confirmed,
  sanitized_observed_evidence, sanitized_readback_evidence, sanitized_live_evidence,
  failure_fingerprint, started_at, completed_at, created_at, updated_at
`;

export function failureFingerprint(...parts) {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("|"))
    .digest("hex");
}

export async function acquireProductionReleaseLease({
  db,
  versionId,
  holder,
  now,
  durationMs = DEFAULT_RELEASE_LEASE_MS,
}) {
  nonEmpty(versionId, "version id");
  nonEmpty(holder, "lease holder");
  const id = releaseLeaseId(versionId);
  const row = await db.prepare(
    `INSERT INTO orchestration_leases (
       id, aggregate_type, aggregate_id, holder, fencing_token, expires_at, created_at
     ) VALUES (?, 'version', ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       holder = excluded.holder,
       fencing_token = orchestration_leases.fencing_token + 1,
       expires_at = excluded.expires_at
     WHERE orchestration_leases.expires_at <= ?
     RETURNING holder, fencing_token, expires_at`,
  ).bind(id, versionId, holder, expiresAt(now, durationMs), now, now).first();
  if (row?.holder !== holder || row.expires_at <= now) throw leaseLost(versionId);
  return {
    id,
    versionId,
    holder,
    fencingToken: Number(row.fencing_token),
    expiresAt: row.expires_at,
    durationMs,
  };
}

export async function renewProductionReleaseLease({ db, lease, now }) {
  const updated = await db.prepare(
    `UPDATE orchestration_leases SET expires_at = ?
     WHERE id = ? AND aggregate_type = 'version' AND aggregate_id = ?
       AND holder = ? AND fencing_token = ? AND expires_at > ?`,
  ).bind(
    expiresAt(now, lease.durationMs),
    lease.id,
    lease.versionId,
    lease.holder,
    lease.fencingToken,
    now,
  ).run();
  if (changes(updated) === 0) throw leaseLost(lease.versionId);
}

export async function releaseProductionReleaseLease({ db, lease, now }) {
  await db.prepare(
    `UPDATE orchestration_leases SET expires_at = ?
     WHERE id = ? AND aggregate_type = 'version' AND aggregate_id = ?
       AND holder = ? AND fencing_token = ?`,
  ).bind(now, lease.id, lease.versionId, lease.holder, lease.fencingToken).run();
}

export async function openProductionReleaseAttempt({
  db,
  manifest,
  lease,
  now,
  leaseNow = now,
}) {
  await assertLeaseCurrent({ db, lease, now: leaseNow });
  const identity = [manifest.versionId, manifest.candidateCommit, manifest.checksum];
  const latest = await db.prepare(
    `SELECT * FROM production_release_attempts
     WHERE version_id = ? AND candidate_commit = ? AND manifest_checksum = ?
     ORDER BY attempt DESC LIMIT 1`,
  ).bind(...identity).first();
  if (latest && latest.status !== "failed") return mapAttempt(latest);
  const attempt = Number(latest?.attempt ?? 0) + 1;
  const idempotencyKey = `production-release:${identity.join(":")}:${attempt}`;
  const inserted = await db.prepare(
    `INSERT INTO production_release_attempts (
       version_id, candidate_commit, manifest_checksum, attempt, idempotency_key,
       status, started_at, created_at, updated_at
     ) SELECT ?, ?, ?, ?, ?, 'running', ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM orchestration_leases
       WHERE id = ? AND aggregate_type = 'version' AND aggregate_id = ?
         AND holder = ? AND fencing_token = ? AND expires_at > ?
     )`,
  ).bind(
    ...identity,
    attempt,
    idempotencyKey,
    now,
    now,
    now,
    lease.id,
    lease.versionId,
    lease.holder,
    lease.fencingToken,
    leaseNow,
  ).run();
  if (changes(inserted) === 0) {
    await assertLeaseCurrent({ db, lease, now: leaseNow });
    throw transitionConflict("attempt creation", manifest.versionId);
  }
  return {
    versionId: manifest.versionId,
    candidateCommit: manifest.candidateCommit,
    manifestChecksum: manifest.checksum,
    attempt,
    idempotencyKey,
    status: "running",
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    failureFingerprint: null,
  };
}

export async function completeProductionReleaseAttempt({
  db,
  manifest,
  attempt,
  lease,
  now,
  leaseNow = now,
}) {
  const updated = await db.prepare(
    `UPDATE production_release_attempts
     SET status = 'succeeded', completed_at = ?, updated_at = ?
     WHERE version_id = ? AND candidate_commit = ? AND manifest_checksum = ?
       AND attempt = ? AND status IN ('pending', 'running')
       AND EXISTS (
         SELECT 1 FROM orchestration_leases
         WHERE id = ? AND aggregate_type = 'version' AND aggregate_id = ?
           AND holder = ? AND fencing_token = ? AND expires_at > ?
       )`,
  ).bind(
    now,
    now,
    manifest.versionId,
    manifest.candidateCommit,
    manifest.checksum,
    attempt,
    lease.id,
    lease.versionId,
    lease.holder,
    lease.fencingToken,
    leaseNow,
  ).run();
  if (changes(updated) === 0) {
    await assertLeaseCurrent({ db, lease, now: leaseNow });
    throw transitionConflict("attempt completion", manifest.versionId);
  }
}

export async function failProductionReleaseAttempt({
  db,
  manifest,
  attempt,
  fingerprint,
  lease,
  now,
  leaseNow = now,
}) {
  const updated = await db.prepare(
    `UPDATE production_release_attempts
     SET status = 'failed', completed_at = ?, updated_at = ?, failure_fingerprint = ?
     WHERE version_id = ? AND candidate_commit = ? AND manifest_checksum = ?
       AND attempt = ? AND status IN ('pending', 'running')
       AND EXISTS (
         SELECT 1 FROM orchestration_leases
         WHERE id = ? AND aggregate_type = 'version' AND aggregate_id = ?
           AND holder = ? AND fencing_token = ? AND expires_at > ?
       )`,
  ).bind(
    now,
    now,
    fingerprint,
    manifest.versionId,
    manifest.candidateCommit,
    manifest.checksum,
    attempt,
    lease.id,
    lease.versionId,
    lease.holder,
    lease.fencingToken,
    leaseNow,
  ).run();
  if (changes(updated) === 0) {
    await assertLeaseCurrent({ db, lease, now: leaseNow });
    throw transitionConflict("attempt failure", manifest.versionId);
  }
}

export async function listReusableProductionTargetSuccesses({ db, manifest }) {
  const rows = await db.prepare(
    `SELECT ${TARGET_COLUMNS} FROM production_release_targets
     WHERE version_id = ? AND candidate_commit = ? AND manifest_checksum = ?
       AND status = 'succeeded'
       AND reconciliation_status IN ('not_required', 'readback_confirmed')
       AND ((platform IN ('web', 'api') AND stage = 'readback')
         OR (platform = 'ios' AND stage = 'live_readback'
           AND json_extract(sanitized_observed_evidence, '$.authoritative') = 1
           AND (live_membership_confirmed = 1
             OR json_extract(sanitized_live_evidence, '$.membershipConfirmed') = 1)))
     ORDER BY platform, app_id, attempt DESC`,
  ).bind(manifest.versionId, manifest.candidateCommit, manifest.checksum).all();
  const exact = new Map();
  for (const row of rows.results) {
    const key = `${row.platform}:${row.app_id}`;
    if (!exact.has(key)) exact.set(key, mapTarget(row));
  }
  return exact;
}

export async function loadLatestProductionTarget({ db, manifest, platform, appId = "" }) {
  return mapTarget(await db.prepare(
    `SELECT ${TARGET_COLUMNS} FROM production_release_targets
     WHERE version_id = ? AND candidate_commit = ? AND manifest_checksum = ?
       AND platform = ? AND app_id = ?
     ORDER BY attempt DESC LIMIT 1`,
  ).bind(
    manifest.versionId,
    manifest.candidateCommit,
    manifest.checksum,
    platform,
    appId,
  ).first());
}

export async function listProductionTargetKeys({ db, manifest }) {
  const rows = await db.prepare(
    `SELECT DISTINCT platform, app_id FROM production_release_targets
     WHERE version_id = ? AND candidate_commit = ? AND manifest_checksum = ?
     ORDER BY platform, app_id`,
  ).bind(manifest.versionId, manifest.candidateCommit, manifest.checksum).all();
  return new Set(rows.results.map((row) => `${row.platform}:${row.app_id}`));
}

export async function countProductionTargetSafeReposts({ db, manifest, platform, appId = "" }) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM production_release_targets
     WHERE version_id = ? AND candidate_commit = ? AND manifest_checksum = ?
       AND platform = ? AND app_id = ?
       AND json_extract(sanitized_observed_evidence, '$.safeRepostAuthorized') = 1`,
  ).bind(
    manifest.versionId,
    manifest.candidateCommit,
    manifest.checksum,
    platform,
    appId,
  ).first();
  return Number(row?.count ?? 0);
}

export async function initializeProductionTargets({
  db,
  manifest,
  targets,
  lease,
  now,
  leaseNow = now,
}) {
  const statements = targets.map(({ platform, app = null }) => db.prepare(
    `INSERT INTO production_release_targets (
       version_id, candidate_commit, manifest_checksum, platform, app_id,
       attempt, stage, status, reconciliation_status,
       app_store_app_id, bundle_id, marketing_version,
       started_at, created_at, updated_at
     ) SELECT ?, ?, ?, ?, ?, 1, ?, 'pending', 'not_required', ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM orchestration_leases
       WHERE id = ? AND aggregate_type = 'version' AND aggregate_id = ?
         AND holder = ? AND fencing_token = ? AND expires_at > ?
     )`,
  ).bind(
    manifest.versionId,
    manifest.candidateCommit,
    manifest.checksum,
    platform,
    app?.id ?? "",
    platform === "ios" ? "test" : "preflight",
    app?.appStoreAppId ?? null,
    app?.bundleId ?? null,
    app?.marketingVersion ?? null,
    now,
    now,
    now,
    lease.id,
    lease.versionId,
    lease.holder,
    lease.fencingToken,
    leaseNow,
  ));
  if (statements.length > 0) {
    const inserted = await db.batch(statements);
    if (inserted.some((result) => changes(result) === 0)) {
      await assertLeaseCurrent({ db, lease, now: leaseNow });
      throw transitionConflict("target initialization", manifest.versionId);
    }
  }
}

export async function beginProductionTarget({
  db,
  manifest,
  platform,
  app = null,
  status = "running",
  reconciliationStatus = "not_required",
  lease,
  now,
  leaseNow = now,
}) {
  const appId = app?.id ?? "";
  const previous = await db.prepare(
    `SELECT COALESCE(MAX(attempt), 0) AS attempt FROM production_release_targets
     WHERE version_id = ? AND candidate_commit = ? AND manifest_checksum = ?
       AND platform = ? AND app_id = ?`,
  ).bind(
    manifest.versionId,
    manifest.candidateCommit,
    manifest.checksum,
    platform,
    appId,
  ).first();
  const attempt = Number(previous?.attempt ?? 0) + 1;
  const stage = platform === "ios" ? "test" : "preflight";
  const inserted = await db.prepare(
    `INSERT INTO production_release_targets (
       version_id, candidate_commit, manifest_checksum, platform, app_id,
       attempt, stage, status, reconciliation_status,
       app_store_app_id, bundle_id, marketing_version,
       started_at, created_at, updated_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM orchestration_leases
       WHERE id = ? AND aggregate_type = 'version' AND aggregate_id = ?
         AND holder = ? AND fencing_token = ? AND expires_at > ?
     )`,
  ).bind(
    manifest.versionId,
    manifest.candidateCommit,
    manifest.checksum,
    platform,
    appId,
    attempt,
    stage,
    status,
    reconciliationStatus,
    app?.appStoreAppId ?? null,
    app?.bundleId ?? null,
    app?.marketingVersion ?? null,
    now,
    now,
    now,
    lease.id,
    lease.versionId,
    lease.holder,
    lease.fencingToken,
    leaseNow,
  ).run();
  if (changes(inserted) === 0) {
    await assertLeaseCurrent({ db, lease, now: leaseNow });
    throw transitionConflict("target creation", manifest.versionId);
  }
  return loadLatestProductionTarget({ db, manifest, platform, appId });
}

export async function updateProductionTarget({
  db,
  target,
  values,
  lease,
  now,
  leaseNow = now,
}) {
  const next = { ...target, ...values, updatedAt: now };
  const updated = await db.prepare(
    `UPDATE production_release_targets SET
       stage = ?, status = ?, external_request_id = ?, reconciliation_status = ?,
       failure_classification = ?, sanitized_error_summary = ?, artifact_identity = ?,
       production_readback_sha = ?, production_release_id = ?, health_status = ?,
       readback_status = ?, app_store_app_id = ?, bundle_id = ?, marketing_version = ?,
       build_number = ?, processing_status = ?, processing_id = ?, review_status = ?,
       review_submission_id = ?, upload_id = ?, review_id = ?, release_status = ?,
       release_id = ?, live_status = ?, live_id = ?, live_marketing_version = ?,
       live_build_number = ?, live_membership_confirmed = ?,
       sanitized_observed_evidence = ?, sanitized_readback_evidence = ?,
       sanitized_live_evidence = ?, failure_fingerprint = ?, completed_at = ?, updated_at = ?
     WHERE version_id = ? AND candidate_commit = ? AND manifest_checksum = ?
       AND platform = ? AND app_id = ? AND attempt = ? AND status <> 'succeeded'
       AND EXISTS (
         SELECT 1 FROM orchestration_leases
         WHERE id = ? AND aggregate_type = 'version' AND aggregate_id = ?
           AND holder = ? AND fencing_token = ? AND expires_at > ?
       )`,
  ).bind(
    next.stage,
    next.status,
    next.externalRequestId,
    next.reconciliationStatus,
    next.failureClassification,
    next.sanitizedErrorSummary === null || next.sanitizedErrorSummary === undefined
      ? null
      : errorSummary(next.sanitizedErrorSummary),
    artifactIdentity(next.artifactIdentity),
    next.productionReadbackSha,
    next.productionReleaseId,
    next.healthStatus,
    next.readbackStatus,
    next.appStoreAppId,
    next.bundleId,
    next.marketingVersion,
    next.buildNumber,
    next.processingStatus,
    next.processingId,
    next.reviewStatus,
    next.reviewSubmissionId,
    next.uploadId,
    next.reviewId,
    next.releaseStatus,
    next.releaseId,
    next.liveStatus,
    next.liveId,
    next.liveMarketingVersion,
    next.liveBuildNumber,
    next.liveMembershipConfirmed === null || next.liveMembershipConfirmed === undefined
      ? null
      : next.liveMembershipConfirmed ? 1 : 0,
    jsonEvidence(next.observedEvidence),
    jsonEvidence(next.readbackEvidence),
    jsonEvidence(next.liveEvidence),
    next.failureFingerprint,
    next.completedAt,
    next.updatedAt,
    next.versionId,
    next.candidateCommit,
    next.manifestChecksum,
    next.platform,
    next.appId,
    next.attempt,
    lease.id,
    lease.versionId,
    lease.holder,
    lease.fencingToken,
    leaseNow,
  ).run();
  if (changes(updated) === 0) {
    await assertLeaseCurrent({ db, lease, now: leaseNow });
    throw transitionConflict("target", next.versionId);
  }
  return loadLatestProductionTarget({
    db,
    manifest: {
      versionId: next.versionId,
      candidateCommit: next.candidateCommit,
      checksum: next.manifestChecksum,
    },
    platform: next.platform,
    appId: next.appId,
  });
}

export function targetFailureValues({ target, error, classification, reconciliationStatus, now }) {
  const summary = errorSummary(error);
  return {
    status: reconciliationStatus === "unknown_outcome" ? "running" : "failed",
    reconciliationStatus,
    failureClassification: classification,
    sanitizedErrorSummary: summary,
    failureFingerprint: failureFingerprint(
      target.versionId,
      target.candidateCommit,
      target.manifestChecksum,
      target.platform,
      target.appId,
      target.stage,
      classification,
      summary,
    ),
    completedAt: reconciliationStatus === "unknown_outcome" ? null : now,
  };
}

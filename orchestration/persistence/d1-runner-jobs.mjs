import { DomainError } from "../domain/errors.mjs";

const DEFAULT_LEASE_MS = 15 * 60_000;

export async function enqueueJob(db, {
  jobId,
  commandId,
  jobType,
  payload,
  payloadHash,
  expiresAt,
  createdAt,
}) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO runner_jobs (
        id, command_id, job_type, payload, payload_hash, status, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .bind(
      jobId,
      commandId,
      jobType,
      JSON.stringify(payload),
      payloadHash,
      expiresAt,
      createdAt,
    )
    .run();
}

export async function claimJob(db, {
  deviceId,
  jobType,
  now,
  leaseMs = DEFAULT_LEASE_MS,
}) {
  const candidate = await db
    .prepare(
      `SELECT * FROM runner_jobs
       WHERE job_type = ? AND (status = 'queued' OR (status = 'claimed' AND expires_at <= ?))
       ORDER BY created_at LIMIT 1`,
    )
    .bind(jobType, now)
    .first();
  if (!candidate) return null;
  const fencingToken = (candidate.fencing_token ?? 0) + 1;
  const newExpiresAt = new Date(new Date(now).getTime() + leaseMs).toISOString();
  const updated = await db
    .prepare(
      `UPDATE runner_jobs
       SET status = 'claimed', device_id = ?, fencing_token = ?, expires_at = ?, claimed_at = ?
       WHERE id = ? AND (status = 'queued' OR (status = 'claimed' AND expires_at <= ?))`,
    )
    .bind(deviceId, fencingToken, newExpiresAt, now, candidate.id, now)
    .run();
  if ((updated.meta?.changes ?? 0) === 0) return null;
  return {
    id: candidate.id,
    commandId: candidate.command_id,
    jobType: candidate.job_type,
    payload: JSON.parse(candidate.payload),
    payloadHash: candidate.payload_hash,
    fencingToken,
    expiresAt: newExpiresAt,
  };
}

export async function completeJob(db, {
  jobId,
  deviceId,
  fencingToken,
  status,
  result,
  now,
}) {
  const row = await db
    .prepare("SELECT * FROM runner_jobs WHERE id = ?")
    .bind(jobId)
    .first();
  if (!row) {
    throw new DomainError("JOB_NOT_FOUND", `Runner job "${jobId}" not found`, { jobId });
  }
  if (
    row.status !== "claimed"
    || row.device_id !== deviceId
    || row.fencing_token !== fencingToken
  ) {
    throw new DomainError("CLAIM_MISMATCH", [
      `Runner job "${jobId}" is not claimed by device "${deviceId}" at fencing token ${fencingToken}`,
    ].join(" "), { jobId, deviceId, fencingToken });
  }
  const finalStatus = status === "failed" ? "failed" : "completed";
  await db
    .prepare(
      `UPDATE runner_jobs SET status = ?, result = ?, completed_at = ?
       WHERE id = ? AND status = 'claimed' AND device_id = ? AND fencing_token = ?`,
    )
    .bind(finalStatus, JSON.stringify(result ?? {}), now, jobId, deviceId, fencingToken)
    .run();
  return { jobId, status: finalStatus };
}

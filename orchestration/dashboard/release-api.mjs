import { enqueueMutation } from "../clickup/outbox.mjs";

const RELEASE_ROLES = new Set(["release_manager", "admin"]);
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class DashboardReleaseError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function assertReleaseRole(roles) {
  if (!Array.isArray(roles) || !roles.some((role) => RELEASE_ROLES.has(role))) {
    throw new DashboardReleaseError(403, "FORBIDDEN", "release_manager or admin role required");
  }
}

export function parseReleaseConfirmation(value, versionName) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DashboardReleaseError(400, "INVALID_BODY", "Request body must be a JSON object");
  }
  const unknown = Object.keys(value).filter((key) => !["confirmationVersion", "requestId"].includes(key));
  if (unknown.length > 0) throw new DashboardReleaseError(400, "INVALID_BODY", "Unknown release confirmation field");
  if (typeof value.confirmationVersion !== "string" || value.confirmationVersion !== versionName) {
    throw new DashboardReleaseError(409, "VERSION_CONFIRMATION_MISMATCH", "输入的版本号必须与待发布版本完全一致");
  }
  if (typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)) {
    throw new DashboardReleaseError(400, "INVALID_REQUEST_ID", "requestId is required and invalid");
  }
  return { confirmationVersion: value.confirmationVersion, requestId: value.requestId };
}

export async function readReleaseRequest(db, { versionId, requestId, statusName, now }) {
  const mutationId = `publish-${versionId}-${requestId}`;
  const existing = await db.prepare("SELECT object_id, field, target, status, expires_at FROM outbox_mutations WHERE id = ?").bind(mutationId).first();
  if (!existing) return null;
  const same = existing.object_id === versionId && existing.field === "status"
    && JSON.parse(existing.target) === statusName;
  const reusable = existing.status === "confirmed"
    || (existing.status === "pending" && existing.expires_at > now);
  if (!same || !reusable) {
    throw new DashboardReleaseError(409, "RELEASE_REQUEST_CONFLICT", "Release request is not reusable");
  }
  return { ok: true, status: "releasing", requestId };
}

export async function enqueueReleaseRequest(db, { versionId, requestId, statusName, expectedBefore, actor, now }) {
  const mutationId = `publish-${versionId}-${requestId}`;
  const existing = await readReleaseRequest(db, { versionId, requestId, statusName, now });
  if (existing) return existing;
  await enqueueMutation(db, {
    mutationId,
    objectType: "version",
    objectId: versionId,
    field: "status",
    expectedBefore,
    target: statusName,
    actor,
    expiresAt: new Date(new Date(now).getTime() + 10 * 60_000).toISOString(),
    createdAt: now,
  });
  return { ok: true, status: "releasing", requestId };
}

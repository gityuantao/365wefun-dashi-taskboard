import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readControl, writeControl } from "../control.mjs";
import { buildDashboard, buildTaskDetail, buildVersionDetail } from "./queries.mjs";
import {
  DashboardReleaseError,
  assertReleaseRole,
  enqueueReleaseRequest,
  parseReleaseConfirmation,
  readReleaseRequest,
} from "./release-api.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SECRET_PATTERN = /^[a-f0-9]{64}$/;
const PROCESS_MUTATION_SECRET = randomBytes(32).toString("hex");

export function resolveOrchestrationMutationSecretPath(
  dataDirectory = process.env.CODEX_TASKBOARD_DATA_DIR ?? path.join(PROJECT_ROOT, ".data"),
) {
  return path.join(path.resolve(dataDirectory), "orchestration-mutation.secret");
}

export const DEFAULT_ORCHESTRATION_MUTATION_SECRET_PATH =
  resolveOrchestrationMutationSecretPath();

function validateMutationSecret(value, source) {
  if (typeof value !== "string" || !SECRET_PATTERN.test(value)) {
    const error = new Error(
      `${source} must contain exactly 64 lowercase hexadecimal characters`,
    );
    error.code = "INVALID_ORCHESTRATION_MUTATION_SECRET";
    throw error;
  }
  return value;
}

async function secureSecretHandle(handle) {
  let metadata = await handle.stat();
  if (!metadata.isFile()) {
    throw new Error("Orchestration mutation secret must be a regular file");
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    await handle.chmod(0o600);
    metadata = await handle.stat();
    if ((metadata.mode & 0o777) !== 0o600) {
      throw new Error("Orchestration mutation secret file mode must be 0600");
    }
  }
}

function secretOpenFlags(fileConstants) {
  if (!Number.isInteger(fileConstants.O_NOFOLLOW) || fileConstants.O_NOFOLLOW === 0) {
    throw new Error("O_NOFOLLOW is required for orchestration mutation secret files");
  }
  return {
    read: fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    create: fileConstants.O_WRONLY
      | fileConstants.O_CREAT
      | fileConstants.O_EXCL
      | fileConstants.O_NOFOLLOW,
  };
}

async function readSharedMutationSecret(secretPath, openFile, readFlags) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let handle;
    try {
      handle = await openFile(secretPath, readFlags);
      await secureSecretHandle(handle);
      const value = await handle.readFile("utf8");
      return validateMutationSecret(value, "Orchestration mutation secret file");
    } catch (error) {
      lastError = error;
      const retryable = error?.code === "ENOENT"
        || (error?.code === "INVALID_ORCHESTRATION_MUTATION_SECRET"
          && attempt < 19);
      if (!retryable) throw error;
      if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      await handle?.close();
    }
  }
  throw lastError;
}

export async function getProcessOrchestrationMutationSecret({
  secretPath = null,
  fileConstants = fsConstants,
  fsOps = { mkdir, open },
  openFile = fsOps.open,
} = {}) {
  const envSecret = process.env.CODEX_TASKBOARD_ORCHESTRATION_SECRET;
  if (typeof envSecret === "string" && envSecret.length > 0) {
    return validateMutationSecret(envSecret, "CODEX_TASKBOARD_ORCHESTRATION_SECRET");
  }
  const flags = secretOpenFlags(fileConstants);
  if (!secretPath) return PROCESS_MUTATION_SECRET;

  await fsOps.mkdir(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await openFile(secretPath, flags.create, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      return readSharedMutationSecret(secretPath, openFile, flags.read);
    }
    throw error;
  }

  const secret = PROCESS_MUTATION_SECRET;
  try {
    await handle.writeFile(secret, "utf8");
    await handle.sync();
    await secureSecretHandle(handle);
  } finally {
    await handle.close();
  }
  return secret;
}

function sendJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(body);
}

function methodNotAllowed(response, allowed) {
  sendJson(response, 405, {
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "Method not allowed",
        details: { allowed },
      },
    },
    { allow: allowed.join(", ") },
  );
}

function authorizedMutation(request, mutationSecret) {
  if (typeof mutationSecret !== "string" || mutationSecret.length === 0) return false;
  const authorization = typeof request.headers.authorization === "string"
    ? request.headers.authorization
    : "";
  const actual = createHash("sha256").update(authorization).digest();
  const expected = createHash("sha256").update(`Bearer ${mutationSecret}`).digest();
  return timingSafeEqual(actual, expected);
}

function unauthorized(response) {
  sendJson(response, 401, {
    error: { code: "UNAUTHORIZED", message: "Mutation authorization required" },
  });
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startDashboardServer({
  db,
  port = 47824,
  versionListUrl = null,
  controlPath = null,
  versionStatusMap = null,
  mutationSecret,
  mutationSecretPath = null,
  productionReadiness = { ready: false, error: "production readiness probe was not configured" },
  productionTargetApps = [],
}) {
  const currentProductionReadiness = async () => (
    typeof productionReadiness === "function"
      ? productionReadiness()
      : productionReadiness
  );
  const resolvedMutationSecret = mutationSecret === undefined
    ? await getProcessOrchestrationMutationSecret({ secretPath: mutationSecretPath })
    : mutationSecret;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const { pathname } = url;
      if (pathname === "/api/orchestration/control") {
        if (request.method === "GET") {
          return sendJson(response, 200, await readControl(controlPath));
        }
        if (request.method === "PUT") {
          if (!authorizedMutation(request, resolvedMutationSecret)) return unauthorized(response);
          let body;
          try {
            body = JSON.parse(await readRequestBody(request));
          } catch {
            return sendJson(response, 400, {
              error: { code: "INVALID_BODY", message: "Request body must be JSON" },
            });
          }
          if (body === null || typeof body !== "object" || Array.isArray(body)
            || typeof body.enabled !== "boolean") {
            return sendJson(response, 400, {
              error: { code: "INVALID_BODY", message: "enabled must be a boolean" },
            });
          }
          return sendJson(response, 200, await writeControl(controlPath, body));
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      if (pathname === "/api/orchestration/dashboard") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return sendJson(response, 200, {
          ...await buildDashboard(db, { versionListUrl }),
          productionReleaseReadiness: await currentProductionReadiness(),
        });
      }

      const taskMatch = pathname.match(/^\/api\/orchestration\/dashboard\/tasks\/([^/]+)$/);
      if (taskMatch) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        let taskId;
        try {
          taskId = decodeURIComponent(taskMatch[1]);
        } catch {
          return sendJson(response, 400, {
            error: { code: "INVALID_PATH", message: "Task id contains invalid encoding" },
          });
        }
        const detail = await buildTaskDetail(db, taskId);
        if (!detail) {
          return sendJson(response, 404, {
            error: { code: "NOT_FOUND", message: "Task not found" },
          });
        }
        return sendJson(response, 200, detail);
      }

      const versionPublishMatch = pathname.match(
        /^\/api\/orchestration\/dashboard\/versions\/([^/]+)\/publish$/,
      );
      if (versionPublishMatch) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        if (!authorizedMutation(request, resolvedMutationSecret)) return unauthorized(response);
        try {
          const actorRoles = JSON.parse(request.headers["x-orchestration-actor-roles"] ?? "[]");
          assertReleaseRole(actorRoles);
        } catch (error) {
          if (error instanceof DashboardReleaseError) {
            return sendJson(response, error.status, { error: { code: error.code, message: error.message } });
          }
          throw error;
        }
        let versionId;
        try {
          versionId = decodeURIComponent(versionPublishMatch[1]);
        } catch {
          return sendJson(response, 400, {
            error: { code: "INVALID_PATH", message: "Version id contains invalid encoding" },
          });
        }
        const detail = await buildVersionDetail(db, versionId, { iosApps: productionTargetApps });
        if (!detail) {
          return sendJson(response, 404, {
            error: { code: "NOT_FOUND", message: "Version not found" },
          });
        }
        let body;
        try {
          body = JSON.parse(await readRequestBody(request));
        } catch {
          return sendJson(response, 400, { error: { code: "INVALID_BODY", message: "Request body must be JSON" } });
        }
        let confirmation;
        try {
          confirmation = parseReleaseConfirmation(body, detail.name);
        } catch (error) {
          if (error instanceof DashboardReleaseError) {
            return sendJson(response, error.status, { error: { code: error.code, message: error.message } });
          }
          throw error;
        }
        const statusName = versionStatusMap && Object.entries(versionStatusMap)
          .find(([, canonical]) => canonical === "releasing")?.[0];
        if (!statusName) {
          return sendJson(response, 500, {
            error: { code: "NO_RELEASING_STATUS", message: "版本状态配置缺少发布中" },
          });
        }
        const now = new Date().toISOString();
        try {
          const existing = await readReleaseRequest(db, {
            versionId, requestId: confirmation.requestId, statusName, now,
          });
          if (existing) return sendJson(response, 200, existing);
        } catch (error) {
          if (error instanceof DashboardReleaseError) return sendJson(response, error.status, { error: { code: error.code, message: error.message } });
          throw error;
        }
        const releaseReadiness = await currentProductionReadiness();
        if (releaseReadiness?.ready !== true) {
          return sendJson(response, 503, {
            error: { code: "PRODUCTION_RUNTIME_NOT_READY", message: releaseReadiness?.error ?? "Production release runtime is not ready" },
          });
        }
        if (!detail.releaseReadiness.ready) {
          return sendJson(response, 409, {
            error: { code: "NOT_RELEASABLE", message: "版本任务未全部就绪或版本已发布" },
          });
        }
        return sendJson(response, 200, await enqueueReleaseRequest(db, {
          versionId, requestId: confirmation.requestId, statusName, expectedBefore: detail.status,
          actor: request.headers["x-orchestration-actor-id"] ?? "unknown", now,
        }));
      }

      const versionMatch = pathname.match(/^\/api\/orchestration\/dashboard\/versions\/([^/]+)$/);
      if (versionMatch) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        let versionId;
        try {
          versionId = decodeURIComponent(versionMatch[1]);
        } catch {
          return sendJson(response, 400, {
            error: { code: "INVALID_PATH", message: "Version id contains invalid encoding" },
          });
        }
        const detail = await buildVersionDetail(db, versionId, { iosApps: productionTargetApps });
        if (!detail) {
          return sendJson(response, 404, {
            error: { code: "NOT_FOUND", message: "Version not found" },
          });
        }
        const runtimeReadiness = await currentProductionReadiness();
        return sendJson(response, 200, {
          ...detail,
          productionRuntimeReadiness: runtimeReadiness,
        });
      }

      return sendJson(response, 404, {
        error: { code: "NOT_FOUND", message: "Route not found" },
      });
    } catch (error) {
      console.error(error);
      return sendJson(response, 500, {
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

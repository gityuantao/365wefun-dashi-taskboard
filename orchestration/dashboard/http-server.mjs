import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readControl, writeControl } from "../control.mjs";
import { enqueueMutation } from "../clickup/outbox.mjs";
import { buildDashboard, buildTaskDetail, buildVersionDetail } from "./queries.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SECRET_PATTERN = /^[a-f0-9]{64}$/;
const PROCESS_MUTATION_SECRET = randomBytes(32).toString("hex");
export const DEFAULT_ORCHESTRATION_MUTATION_SECRET_PATH = path.join(
  PROJECT_ROOT,
  ".data",
  "orchestration-mutation.secret",
);

function validateMutationSecret(value, source) {
  if (typeof value !== "string" || !SECRET_PATTERN.test(value)) {
    throw new Error(`${source} must contain exactly 64 lowercase hexadecimal characters`);
  }
  return value;
}

async function tightenSecretPermissions(secretPath) {
  try {
    await chmod(secretPath, 0o600);
  } catch {}
}

async function readSharedMutationSecret(secretPath) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const secret = validateMutationSecret(
        await readFile(secretPath, "utf8"),
        "Orchestration mutation secret file",
      );
      await tightenSecretPermissions(secretPath);
      return secret;
    } catch (error) {
      lastError = error;
      if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

export async function getProcessOrchestrationMutationSecret({ secretPath = null } = {}) {
  const envSecret = process.env.CODEX_TASKBOARD_ORCHESTRATION_SECRET;
  if (typeof envSecret === "string" && envSecret.length > 0) {
    return validateMutationSecret(envSecret, "CODEX_TASKBOARD_ORCHESTRATION_SECRET");
  }
  if (!secretPath) return PROCESS_MUTATION_SECRET;

  await mkdir(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(secretPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") return readSharedMutationSecret(secretPath);
    throw error;
  }

  const secret = randomBytes(32).toString("hex");
  try {
    await handle.writeFile(secret, "utf8");
    await handle.sync();
  } catch (error) {
    try {
      await unlink(secretPath);
    } catch {}
    throw error;
  } finally {
    await handle.close();
  }
  await tightenSecretPermissions(secretPath);
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
}) {
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
        return sendJson(response, 200, await buildDashboard(db, { versionListUrl }));
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
        let versionId;
        try {
          versionId = decodeURIComponent(versionPublishMatch[1]);
        } catch {
          return sendJson(response, 400, {
            error: { code: "INVALID_PATH", message: "Version id contains invalid encoding" },
          });
        }
        const detail = await buildVersionDetail(db, versionId);
        if (!detail) {
          return sendJson(response, 404, {
            error: { code: "NOT_FOUND", message: "Version not found" },
          });
        }
        if (!detail.releasable) {
          return sendJson(response, 409, {
            error: {
              code: "NOT_RELEASABLE",
              message: "版本任务未全部就绪或版本已发布",
            },
          });
        }
        if (!versionStatusMap) {
          return sendJson(response, 500, {
            error: { code: "NO_RELEASING_STATUS", message: "版本状态配置缺少发布中" },
          });
        }
        const statusName = Object.entries(versionStatusMap)
          .find(([, canonical]) => canonical === "releasing")?.[0];
        if (!statusName) {
          return sendJson(response, 500, {
            error: { code: "NO_RELEASING_STATUS", message: "版本状态配置缺少发布中" },
          });
        }
        const now = new Date().toISOString();
        await enqueueMutation(db, {
          mutationId: `publish-${versionId}-${Date.now()}`,
          objectType: "version",
          objectId: versionId,
          field: "status",
          expectedBefore: null,
          target: statusName,
          actor: "dashboard",
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          createdAt: now,
        });
        return sendJson(response, 200, { ok: true, status: "releasing" });
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
        const detail = await buildVersionDetail(db, versionId);
        if (!detail) {
          return sendJson(response, 404, {
            error: { code: "NOT_FOUND", message: "Version not found" },
          });
        }
        return sendJson(response, 200, detail);
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

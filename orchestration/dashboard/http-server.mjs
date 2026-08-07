import { createServer } from "node:http";

import { readControl, writeControl } from "../control.mjs";
import { enqueueMutation } from "../clickup/outbox.mjs";
import { buildDashboard, buildTaskDetail, buildVersionDetail } from "./queries.mjs";

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
}) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const { pathname } = url;
      if (pathname === "/api/orchestration/control") {
        if (request.method === "GET") {
          return sendJson(response, 200, await readControl(controlPath));
        }
        if (request.method === "PUT") {
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

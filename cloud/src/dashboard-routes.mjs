import {
  buildDashboard,
  buildTaskDetail,
  buildVersionDetail,
} from "../../orchestration/dashboard/queries.mjs";
import { loadClickUpConfig } from "../../orchestration/clickup/config-registry.mjs";
import { enqueueMutation } from "../../orchestration/clickup/outbox.mjs";

function json(status, value, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function methodNotAllowed(allowed) {
  return json(405, {
    error: {
      code: "METHOD_NOT_ALLOWED",
      message: "Method not allowed",
      details: { allowed },
    },
  }, { allow: allowed.join(", ") });
}

function versionListUrlFromConfig(configJson) {
  if (!configJson) return null;
  try {
    const config = JSON.parse(configJson);
    const listId = config.lists?.version?.id ?? config.lists?.versionSandbox?.id ?? "";
    if (!config.spaceId || !listId) return null;
    return `https://app.clickup.com/${encodeURIComponent(config.spaceId)}/v/l/${encodeURIComponent(listId)}`;
  } catch {
    return null;
  }
}

export async function routeDashboardRequest(request, env) {
  if (env.ORCHESTRATION_DIAGNOSTIC_ENABLED !== "true") {
    return json(404, {
      error: {
        code: "ORCHESTRATION_DISABLED",
        message: "Orchestration diagnostic API is disabled",
      },
    });
  }

  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === "/api/orchestration/dashboard") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return json(200, await buildDashboard(env.DB, {
      versionListUrl: versionListUrlFromConfig(env.CLICKUP_CONFIG),
    }));
  }

  const taskMatch = pathname.match(/^\/api\/orchestration\/dashboard\/tasks\/([^/]+)$/);
  if (taskMatch) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    let taskId;
    try {
      taskId = decodeURIComponent(taskMatch[1]);
    } catch {
      return json(400, {
        error: { code: "INVALID_PATH", message: "Task id contains invalid encoding" },
      });
    }
    const detail = await buildTaskDetail(env.DB, taskId);
    if (!detail) {
      return json(404, { error: { code: "NOT_FOUND", message: "Task not found" } });
    }
    return json(200, detail);
  }

  const versionMatch = pathname.match(/^\/api\/orchestration\/dashboard\/versions\/([^/]+)$/);
  const versionPublishMatch = pathname.match(/^\/api\/orchestration\/dashboard\/versions\/([^/]+)\/publish$/);
  if (versionPublishMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    let versionId;
    try {
      versionId = decodeURIComponent(versionPublishMatch[1]);
    } catch {
      return json(400, {
        error: { code: "INVALID_PATH", message: "Version id contains invalid encoding" },
      });
    }
    const detail = await buildVersionDetail(env.DB, versionId);
    if (!detail) {
      return json(404, { error: { code: "NOT_FOUND", message: "Version not found" } });
    }
    if (!detail.releasable) {
      return json(409, {
        error: {
          code: "NOT_RELEASABLE",
          message: "版本任务未全部就绪或版本已发布",
        },
      });
    }
    const config = loadClickUpConfig(JSON.parse(env.CLICKUP_CONFIG));
    const statusName = Object.entries(config.versionStatusMap)
      .find(([, canonical]) => canonical === "releasing")?.[0];
    if (!statusName) {
      return json(500, {
        error: { code: "NO_RELEASING_STATUS", message: "版本状态配置缺少发布中" },
      });
    }
    const now = new Date().toISOString();
    await enqueueMutation(env.DB, {
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
    return json(200, { ok: true, status: "releasing" });
  }
  if (versionMatch) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    let versionId;
    try {
      versionId = decodeURIComponent(versionMatch[1]);
    } catch {
      return json(400, {
        error: { code: "INVALID_PATH", message: "Version id contains invalid encoding" },
      });
    }
    const detail = await buildVersionDetail(env.DB, versionId);
    if (!detail) {
      return json(404, { error: { code: "NOT_FOUND", message: "Version not found" } });
    }
    return json(200, detail);
  }

  return json(404, { error: { code: "NOT_FOUND", message: "API route not found" } });
}

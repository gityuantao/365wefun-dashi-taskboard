import {
  buildDashboard,
  buildTaskDetail,
  buildVersionDetail,
} from "../../orchestration/dashboard/queries.mjs";

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
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
  });
}

function versionListUrlFromConfig(configJson) {
  if (!configJson) return null;
  try {
    const config = JSON.parse(configJson);
    const listId = config.lists?.version?.id ?? config.lists?.versionSandbox?.id ?? "";
    return `https://app.clickup.com/${config.spaceId}/v/l/${listId}`;
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
    const detail = await buildTaskDetail(env.DB, decodeURIComponent(taskMatch[1]));
    if (!detail) {
      return json(404, { error: { code: "NOT_FOUND", message: "Task not found" } });
    }
    return json(200, detail);
  }

  const versionMatch = pathname.match(/^\/api\/orchestration\/dashboard\/versions\/([^/]+)$/);
  if (versionMatch) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const detail = await buildVersionDetail(env.DB, decodeURIComponent(versionMatch[1]));
    if (!detail) {
      return json(404, { error: { code: "NOT_FOUND", message: "Version not found" } });
    }
    return json(200, detail);
  }

  return json(404, { error: { code: "NOT_FOUND", message: "API route not found" } });
}

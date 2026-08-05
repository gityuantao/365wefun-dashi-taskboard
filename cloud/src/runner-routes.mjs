import { DomainError } from "../../orchestration/domain/errors.mjs";
import {
  claimJob,
  completeJob,
} from "../../orchestration/persistence/d1-runner-jobs.mjs";

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(error) {
  if (!(error instanceof DomainError)) throw error;
  const status = error.code === "CLAIM_MISMATCH" ? 409 : 400;
  return json(status, {
    error: { code: error.code, message: error.message },
  });
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new DomainError("INVALID_CONTENT_TYPE", "Request body must be application/json");
  }
  try {
    return JSON.parse(await request.text());
  } catch {
    throw new DomainError("INVALID_JSON", "Request body is not valid JSON");
  }
}

function nowFromEnv(env) {
  return env.ORCHESTRATION_NOW ?? new Date().toISOString();
}

export async function routeRunnerRequest(request, env, url) {
  const { pathname } = url;
  if (pathname === "/api/runner/jobs/next") {
    if (request.method !== "GET") {
      return json(405, {
        error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
      });
    }
    const deviceId = url.searchParams.get("device_id");
    const jobType = url.searchParams.get("job_type");
    if (!deviceId || !jobType) {
      return json(400, {
        error: {
          code: "MISSING_PARAMETER",
          message: "device_id and job_type query parameters are required",
        },
      });
    }
    const job = await claimJob(env.DB, { deviceId, jobType, now: nowFromEnv(env) });
    if (!job) return new Response(null, { status: 204 });
    return json(200, { job });
  }

  const resultMatch = pathname.match(/^\/api\/runner\/jobs\/([^/]+)\/result$/);
  if (resultMatch) {
    if (request.method !== "POST") {
      return json(405, {
        error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
      });
    }
    try {
      const body = await readJson(request);
      const result = await completeJob(env.DB, {
        jobId: decodeURIComponent(resultMatch[1]),
        deviceId: body.deviceId,
        fencingToken: body.fencingToken,
        status: body.status,
        result: body.result,
        now: nowFromEnv(env),
      });
      return json(200, result);
    } catch (error) {
      return errorResponse(error);
    }
  }

  return json(404, {
    error: { code: "NOT_FOUND", message: "API route not found" },
  });
}

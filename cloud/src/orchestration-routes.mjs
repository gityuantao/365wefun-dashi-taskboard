import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { DomainError } from "../../orchestration/domain/errors.mjs";
import { loadCommandResult } from "../../orchestration/persistence/d1-event-store.mjs";

const JSON_BODY_LIMIT = 64 * 1024;

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

function domainErrorResponse(error) {
  if (error instanceof DomainError) {
    const status = error.code === "VERSION_CONFLICT" ? 409 : 400;
    const payload = {
      error: {
        code: error.code,
        message: error.message,
      },
    };
    if (error.details !== undefined) payload.error.details = error.details;
    return json(status, payload);
  }
  throw error;
}

async function readJsonBody(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new DomainError(
      "INVALID_CONTENT_TYPE",
      "Request body must be application/json",
    );
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > JSON_BODY_LIMIT) {
    throw new DomainError("BODY_TOO_LARGE", "Request body exceeds 64 KiB", {
      limit: JSON_BODY_LIMIT,
    });
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DomainError("INVALID_JSON", "Request body is not valid JSON");
  }
  return value;
}

export async function routeOrchestrationRequest(request, env) {
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
  if (pathname === "/api/orchestration/commands") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    try {
      const command = parseCommandEnvelope(await readJsonBody(request));
      const now = env.ORCHESTRATION_NOW ?? new Date().toISOString();
      const result = await dispatchCommand({ db: env.DB, command, now });
      return json(202, { commandId: result.commandId, status: result.status });
    } catch (error) {
      return domainErrorResponse(error);
    }
  }

  const commandMatch = pathname.match(/^\/api\/orchestration\/commands\/([^/]+)$/);
  if (commandMatch) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    let commandId;
    try {
      commandId = decodeURIComponent(commandMatch[1]);
    } catch {
      return json(400, {
        error: { code: "INVALID_PATH", message: "Command id contains invalid encoding" },
      });
    }
    const result = await loadCommandResult(env.DB, commandId);
    if (!result) {
      return json(404, {
        error: { code: "NOT_FOUND", message: "Command not found" },
      });
    }
    return json(200, result);
  }

  return json(404, {
    error: { code: "NOT_FOUND", message: "API route not found" },
  });
}

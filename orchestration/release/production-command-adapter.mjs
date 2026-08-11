import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createWebAdapter } from "./adapters/web.mjs";
import { sanitizeObservedEvidenceString } from "../domain/redaction.mjs";

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function requiredString(value, label) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function sanitize(value) {
  const redacted = String(value ?? "")
    .replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/gi, "[REDACTED]")
    .replace(/authorization\s*:\s*bearer\s+[^\s,;]+/gi, "[REDACTED]")
    .replace(/cookie\s*:\s*[^\r\n]+/gi, "[REDACTED]")
    .replace(/(?:token|secret|password|api[_-]?key|signature)\s*[=:]\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[REDACTED]@")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]");
  return sanitizeObservedEvidenceString(redacted);
}

function finalJson(stdout) {
  const line = String(stdout ?? "").trim().split(/\r?\n/).at(-1);
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed;
  } catch {
    throw new Error("production release command did not return final JSON evidence");
  }
}

function sanitizeEvidence(value) {
  if (typeof value === "string") return sanitizeObservedEvidenceString(value);
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      sanitizeObservedEvidenceString(key), sanitizeEvidence(child),
    ]));
  }
  return value;
}

function validateCommandResult(value) {
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (sanitizeObservedEvidenceString(key) !== key) throw new Error("production release command returned unsafe evidence");
    if (/evidence|log|comment/i.test(key)) {
      result[key] = sanitizeEvidence(child);
      continue;
    }
    if (typeof child === "string" && sanitizeObservedEvidenceString(child) !== child) {
      throw new Error(`production release command returned unsafe ${key}`);
    }
    result[key] = child && typeof child === "object" ? validateCommandResult(child) : child;
  }
  return result;
}

function manifestEnvironment({ mode, manifest, platform = "", idempotencyKey = "", deployment = null, readbackLocator = null, runtime }) {
  if (!manifest || !SHA_PATTERN.test(String(manifest.candidateCommit ?? ""))) {
    throw new Error("production release requires a frozen full Candidate commit");
  }
  const candidateEvidenceMode = mode === "regression" || mode === "artifact";
  return {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    PRODUCTION_RELEASE_MODE: mode,
    PRODUCTION_VERSION_ID: requiredString(manifest.versionId, "manifest versionId"),
    PRODUCTION_CANDIDATE_COMMIT: manifest.candidateCommit,
    PRODUCTION_MANIFEST_CHECKSUM: candidateEvidenceMode
      ? String(manifest.checksum ?? "")
      : requiredString(manifest.checksum, "manifest checksum"),
    PRODUCTION_ARTIFACT_IDENTITY: JSON.stringify(manifest.artifactIdentity ?? null),
    PRODUCTION_PLATFORM: platform,
    PRODUCTION_IDEMPOTENCY_KEY: idempotencyKey,
    PRODUCTION_EXTERNAL_REQUEST_ID: String(deployment?.externalRequestId ?? ""),
    PRODUCTION_RELEASE_ID: String(deployment?.productionReleaseId ?? ""),
    PRODUCTION_READBACK_LOCATOR: JSON.stringify(readbackLocator ?? deployment ?? null),
    PRODUCTION_CONFIG_PATH: runtime.productionConfigPath,
  };
}

export function createReleaseAdapter({ runtime, projectRoot, runCommand = execFileAsync }) {
  if (!Array.isArray(runtime?.productionReleaseCommand) || runtime.productionReleaseCommand.length === 0) {
    throw new Error("productionReleaseCommand is required");
  }
  requiredString(runtime.productionConfigPath, "productionConfigPath");
  const [file, ...args] = runtime.productionReleaseCommand;
  const timeout = Number(runtime.productionReleaseTimeoutMs ?? 45 * 60_000);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("productionReleaseTimeoutMs must be positive");

  async function invoke(mode, options) {
    try {
      const result = await runCommand(file, args, {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        timeout,
        signal: options.signal,
        env: manifestEnvironment({ mode, runtime, ...options }),
      });
      const parsed = finalJson(result.stdout);
      return mode === "regression" ? sanitizeEvidence(parsed) : validateCommandResult(parsed);
    } catch (error) {
      if (/final JSON evidence/.test(error?.message ?? "")) throw error;
      const kind = error?.name === "AbortError"
        ? "aborted"
        : error?.killed || error?.code === "ETIMEDOUT"
          ? "timed out"
          : "failed";
      const detail = sanitize(error?.stderr || error?.message || "unknown command error");
      throw new Error(`production release command ${kind}: ${detail}`);
    }
  }

  const web = createWebAdapter({
    deployer: {
      preflight: ({ manifest, platform, signal }) => invoke("preflight", { manifest, platform, signal }),
      upload: ({ manifest, platform, idempotencyKey, signal }) => invoke("upload", { manifest, platform, idempotencyKey, signal }),
      switchEntry: ({ manifest, platform, idempotencyKey, signal }) => invoke("switch", { manifest, platform, idempotencyKey, signal }),
      healthCheck: ({ manifest, platform, signal }) => invoke("health", { manifest, platform, signal }),
      readback: ({ manifest, platform, readbackLocator, externalRequestId, idempotencyKey, productionReleaseId, signal }) => invoke("readback", {
        manifest, platform, readbackLocator,
        idempotencyKey,
        deployment: { externalRequestId, productionReleaseId },
        signal,
      }),
    },
  });
  return {
    async collectRegressionEvidence(manifest, options = {}) {
      return invoke("regression", { manifest, signal: options.signal });
    },
    async identifyArtifact(manifest, options = {}) {
      return invoke("artifact", { manifest, signal: options.signal });
    },
    async release(options) {
      return web.release(options);
    },
    async readback(options) {
      return web.readback(options);
    },
  };
}

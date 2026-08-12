import { spawn } from "node:child_process";

import { redactCredentials } from "../domain/redaction.mjs";

const APP_ID = "wx1fdac5e27c6b5366";
const DEFAULT_TIMEOUT_MS = 45 * 60_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const STAGES = Object.freeze([
  "test", "build", "inspectArtifact", "upload", "readUpload",
  "submitReview", "readReview", "release", "readLive",
]);
const LOCAL_STAGES = new Set(["test", "build", "inspectArtifact"]);
const MUTATION_LOOKUP = Object.freeze({
  upload: "readUpload",
  submitReview: "readReview",
  release: "readLive",
});
const UNKNOWN_OUTCOME_CODES = new Set([
  "COMMAND_TIMEOUT", "COMMAND_OUTPUT_TOO_LARGE", "COMMAND_NONZERO", "FINAL_JSON_INVALID",
]);
const CLASSIFICATIONS = new Set([
  "validation", "product_rework", "release_infrastructure", "external_unknown",
]);
const EVIDENCE_FIELDS = Object.freeze([
  "appId", "version", "candidateCommit", "manifestChecksum", "artifactDigest",
  "artifactSize", "artifactIdentity", "artifactPath", "uploadId", "externalRequestId",
  "reviewSubmissionId", "reviewId", "reviewStatus", "releaseId", "releaseStatus",
  "liveId", "liveStatus", "authoritative", "checkedAt", "status",
]);

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw typedError(`mini-program release ${field} is required`, "validation", true);
  }
  return value.trim();
}

function positiveTimeout(value) {
  const timeout = Number(value ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;
}

function cleanText(value) {
  let text = redactCredentials(String(value ?? "mini-program command failed"));
  text = text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > 180) return "[REDACTED oversized mini-program command output]";
  return text || "mini-program command failed";
}

function typedError(message, classification = "external_unknown", deterministic = false, code) {
  const error = new Error(cleanText(message));
  error.name = "WechatReleaseCommandError";
  error.failureClassification = CLASSIFICATIONS.has(classification) ? classification : "external_unknown";
  if (deterministic) error.deterministic = true;
  if (code) error.code = code;
  return error;
}

function sanitizeEvidence(value) {
  const result = {};
  for (const field of EVIDENCE_FIELDS) {
    const item = value?.[field];
    if (typeof item === "string") result[field] = cleanText(item);
    else if (typeof item === "number" && Number.isFinite(item)) result[field] = item;
    else if (typeof item === "boolean") result[field] = item;
  }
  return result;
}

function killProcessGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
}

export function runCommandBoundary(file, args, {
  cwd,
  env,
  timeout = DEFAULT_TIMEOUT_MS,
  signal,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const child = spawn(file, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      operation();
    };
    const append = (current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > MAX_COMMAND_OUTPUT_BYTES) {
        killProcessGroup(child);
        finish(() => reject(typedError("mini-program command output exceeded the bounded limit", "validation", true, "COMMAND_OUTPUT_TOO_LARGE")));
      }
      return next;
    };
    const abort = () => {
      killProcessGroup(child);
      finish(() => reject(typedError("mini-program command aborted", "external_unknown", false, "COMMAND_ABORTED")));
    };
    const timer = setTimeout(() => {
      killProcessGroup(child);
      finish(() => reject(typedError("mini-program command timed out", "release_infrastructure", false, "COMMAND_TIMEOUT")));
    }, positiveTimeout(timeout));
    timer.unref?.();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => finish(() => reject(typedError(error.message, "release_infrastructure"))));
    child.on("close", (code, childSignal) => finish(() => resolve({
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      exitCode: code,
      signal: childSignal,
    })));
  });
}

function parseFinalJson(result, stage) {
  const stdout = String(result?.stdout ?? "");
  const stderr = String(result?.stderr ?? "");
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_COMMAND_OUTPUT_BYTES) {
    throw typedError("mini-program command output exceeded the bounded limit", "validation", true, "COMMAND_OUTPUT_TOO_LARGE");
  }
  const exitCode = result?.exitCode ?? result?.code ?? 0;
  if (exitCode !== 0) {
    throw typedError(`${stage} command exited unsuccessfully: ${stderr}`, "release_infrastructure", false, "COMMAND_NONZERO");
  }
  const line = stdout.trim().split(/\r?\n/u).at(-1);
  if (!line || Buffer.byteLength(line) > 16 * 1024) {
    throw typedError(`${stage} command did not return bounded final JSON evidence`, "validation", true, "FINAL_JSON_INVALID");
  }
  let value;
  try { value = JSON.parse(line); } catch {
    throw typedError(`${stage} command did not return final JSON evidence`, "validation", true, "FINAL_JSON_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw typedError(`${stage} command did not return an evidence object`, "validation", true, "FINAL_JSON_INVALID");
  }
  if (value.ok === false) {
    throw typedError(
      value.error?.message ?? `${stage} command failed`,
      value.error?.classification,
      value.error?.deterministic === true,
    );
  }
  return value;
}

function assertExact(value, field, expected) {
  if (String(value?.[field] ?? "") !== String(expected ?? "")) {
    throw typedError(`mini-program ${field} does not match the frozen Candidate identity`, "validation", true);
  }
}

function assertIdentity(value, { manifest, app, evidence }, stage) {
  assertExact(value, "appId", APP_ID);
  assertExact(app, "appId", APP_ID);
  assertExact(value, "version", requiredString(app?.version, "app.version"));
  assertExact(value, "candidateCommit", requiredString(manifest?.candidateCommit, "manifest.candidateCommit"));
  assertExact(value, "manifestChecksum", requiredString(manifest?.checksum, "manifest.checksum"));
  if (evidence?.artifactDigest) assertExact(value, "artifactDigest", evidence.artifactDigest);
  if (["readUpload", "readReview", "readLive"].includes(stage)
    && value.status === "absent" && value.authoritative === true) {
    return sanitizeEvidence(value);
  }
  if (stage === "readUpload") {
    if (value.authoritative !== true || !value.uploadId) {
      throw typedError("mini-program upload readback is not authoritative", "validation", true);
    }
    if (evidence?.uploadId !== undefined) assertExact(value, "uploadId", evidence.uploadId);
  }
  if (stage === "readReview") {
    if (value.authoritative !== true || !value.uploadId || !value.reviewSubmissionId || !value.reviewId) {
      throw typedError("mini-program review readback is not authoritative", "validation", true);
    }
    for (const field of ["uploadId", "reviewSubmissionId", "reviewId"]) {
      if (evidence?.[field] !== undefined) assertExact(value, field, evidence[field]);
    }
  }
  if (stage === "readLive") {
    if (value.authoritative !== true || value.liveStatus !== "live" || !value.liveId) {
      throw typedError("mini-program live readback is not authoritative and live", "validation", true);
    }
    for (const field of ["uploadId", "reviewSubmissionId", "reviewId", "releaseId"]) {
      requiredString(value?.[field], `readLive.${field}`);
      if (evidence?.[field] !== undefined) assertExact(value, field, evidence[field]);
    }
  }
  if (stage === "upload") requiredString(value?.uploadId, "upload.uploadId");
  if (stage === "submitReview") {
    assertExact(value, "uploadId", requiredString(evidence?.uploadId, "evidence.uploadId"));
    requiredString(value?.reviewSubmissionId, "submitReview.reviewSubmissionId");
    requiredString(value?.reviewId, "submitReview.reviewId");
  }
  if (stage === "release") {
    for (const field of ["uploadId", "reviewSubmissionId", "reviewId"]) {
      assertExact(value, field, requiredString(evidence?.[field], `evidence.${field}`));
    }
    requiredString(value?.releaseId, "release.releaseId");
  }
  return sanitizeEvidence(value);
}

function environmentFor(stage, { manifest, app, evidence = {}, idempotencyKey }, configuration) {
  const env = {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    MINI_PROGRAM_STAGE: stage,
    MINI_PROGRAM_APP_ID: requiredString(app?.appId, "app.appId"),
    MINI_PROGRAM_VERSION: requiredString(app?.version, "app.version"),
    MINI_PROGRAM_EVIDENCE: JSON.stringify(sanitizeEvidence(evidence)),
    MINI_PROGRAM_ARTIFACT_DIGEST: String(evidence.artifactDigest ?? ""),
    MINI_PROGRAM_ARTIFACT_SIZE: String(evidence.artifactSize ?? ""),
    MINI_PROGRAM_ARTIFACT_IDENTITY: String(evidence.artifactIdentity ?? ""),
    PRODUCTION_CANDIDATE_COMMIT: requiredString(manifest?.candidateCommit, "manifest.candidateCommit"),
    PRODUCTION_CANDIDATE_REF: requiredString(manifest?.candidateRef, "manifest.candidateRef"),
    PRODUCTION_MANIFEST_CHECKSUM: requiredString(manifest?.checksum, "manifest.checksum"),
    PRODUCTION_VERSION_ID: requiredString(manifest?.versionId, "manifest.versionId"),
    MINI_PROGRAM_SANDBOX_PROVIDER_MODULE: requiredString(configuration.sandboxProviderModule, "sandboxProviderModule"),
    MINI_PROGRAM_STAGE_RUNNER_MODULE: requiredString(configuration.stageRunnerModule, "stageRunnerModule"),
  };
  if (LOCAL_STAGES.has(stage)) Object.assign(env, {
    MINI_PROGRAM_APP_IDENTITY: requiredString(app?.id, "app.id"),
    MINI_PROGRAM_SOURCE_DIRECTORY: requiredString(app?.sourceDirectory, "app.sourceDirectory"),
    MINI_PROGRAM_ARTIFACT_DIRECTORY: requiredString(app?.artifactDirectory, "app.artifactDirectory"),
    MINI_PROGRAM_DESCRIPTION: requiredString(app?.description, "app.description"),
    MINI_PROGRAM_REPO_PATH: requiredString(configuration.repoPath, "repoPath"),
    MINI_PROGRAM_ARTIFACT_ROOT: requiredString(configuration.artifactRoot, "artifactRoot"),
    MINI_PROGRAM_PRODUCTION_API_ALLOWLIST: JSON.stringify(configuration.productionApiAllowlist),
  });
  else Object.assign(env, {
    MINI_PROGRAM_CREDENTIALS_PATH: requiredString(configuration.credentialsPath, "credentialsPath"),
    MINI_PROGRAM_REVIEW_CONFIGURATION_PATH: requiredString(configuration.reviewConfigurationPath, "reviewConfigurationPath"),
    MINI_PROGRAM_REVIEW_CONFIGURATION_REF: requiredString(app?.reviewConfigurationRef, "app.reviewConfigurationRef"),
    MINI_PROGRAM_IDEMPOTENCY_KEY: String(idempotencyKey ?? ""),
  });
  return env;
}

export function createWechatReleaseAdapter({
  command,
  credentialsPath,
  reviewConfigurationPath,
  repoPath,
  artifactRoot,
  productionApiAllowlist = [],
  sandboxProviderModule = "platform-sandbox.mjs",
  stageRunnerModule = "wechat-stage-runner.mjs",
  runCommand = runCommandBoundary,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cwd,
} = {}) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.trim() === "")) {
    throw typedError("mini-program release command is not configured", "validation", true);
  }
  const [file, ...args] = command;
  const invoke = async (stage, context, { reconcile = true } = {}) => {
    if (MUTATION_LOOKUP[stage] && !String(context?.idempotencyKey ?? "").trim()) {
      throw typedError(`${stage} requires a stable idempotency identity`, "validation", true);
    }
    if (stage === "release") {
      if (context?.evidence?.reviewStatus !== "approved") {
        throw typedError("release requires an approved review", "validation", true);
      }
      if (context.evidence.authoritative !== true) {
        throw typedError("release requires authoritative review approval", "validation", true);
      }
    }
    let result;
    try {
      result = await runCommand(file, args, {
        cwd,
        timeout: positiveTimeout(timeoutMs),
        signal: context?.signal,
        env: environmentFor(stage, context, {
          credentialsPath, reviewConfigurationPath, repoPath, artifactRoot, productionApiAllowlist,
          sandboxProviderModule, stageRunnerModule,
        }),
      });
    } catch (error) {
      const normalized = error?.name === "WechatReleaseCommandError"
        ? error
        : typedError(error?.message, error?.failureClassification, error?.deterministic === true, error?.code);
      if (reconcile && MUTATION_LOOKUP[stage]
        && (normalized.failureClassification === "external_unknown" || UNKNOWN_OUTCOME_CODES.has(normalized.code))) {
        return invoke(MUTATION_LOOKUP[stage], context, { reconcile: false });
      }
      throw normalized;
    }
    try {
      return assertIdentity(parseFinalJson(result, stage), context, stage);
    } catch (error) {
      if (reconcile && MUTATION_LOOKUP[stage]
        && (error.failureClassification === "external_unknown" || UNKNOWN_OUTCOME_CODES.has(error.code))) {
        return invoke(MUTATION_LOOKUP[stage], context, { reconcile: false });
      }
      throw error;
    }
  };
  return Object.fromEntries(STAGES.map((stage) => [stage, (context) => invoke(stage, context)]));
}

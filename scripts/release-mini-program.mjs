#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { redactCredentials } from "../orchestration/domain/redaction.mjs";

const execFile = promisify(execFileCallback);
const APP_ID = "wx1fdac5e27c6b5366";
const STAGES = new Set(["test", "build", "inspectArtifact", "upload", "readUpload", "submitReview", "readReview", "release", "readLive"]);
const NETWORK_STAGES = new Set(["upload", "readUpload", "submitReview", "readReview", "release", "readLive"]);
const MUTATIONS = new Set(["upload", "submitReview", "release"]);
const ALLOWED_ENV = new Set([
  "PATH", "LANG", "MINI_PROGRAM_STAGE", "MINI_PROGRAM_APP_ID", "MINI_PROGRAM_VERSION",
  "MINI_PROGRAM_APP_DESCRIPTOR", "MINI_PROGRAM_CREDENTIALS_PATH",
  "MINI_PROGRAM_REVIEW_CONFIGURATION_PATH", "MINI_PROGRAM_REVIEW_CONFIGURATION_REF",
  "MINI_PROGRAM_IDEMPOTENCY_KEY", "MINI_PROGRAM_EVIDENCE", "MINI_PROGRAM_ARTIFACT_DIGEST",
  "MINI_PROGRAM_ARTIFACT_SIZE", "MINI_PROGRAM_ARTIFACT_IDENTITY", "MINI_PROGRAM_REPO_PATH",
  "MINI_PROGRAM_ARTIFACT_ROOT", "MINI_PROGRAM_PRODUCTION_API_ALLOWLIST",
  "PRODUCTION_CANDIDATE_COMMIT", "PRODUCTION_CANDIDATE_REF",
  "PRODUCTION_MANIFEST_CHECKSUM", "PRODUCTION_VERSION_ID",
]);
const OUTPUT_FIELDS = new Set([
  "ok", "appId", "version", "candidateCommit", "manifestChecksum", "artifactDigest",
  "artifactSize", "artifactIdentity", "artifactPath", "uploadId", "externalRequestId",
  "reviewSubmissionId", "reviewId", "reviewStatus", "releaseId", "releaseStatus",
  "liveId", "liveStatus", "authoritative", "checkedAt", "status", "error",
]);

function required(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`mini-program configuration missing ${field}`);
  return value.trim();
}

function cleanText(value) {
  let result = redactCredentials(String(value ?? "mini-program operation failed"))
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (result.length > 256) result = "[REDACTED oversized output]";
  return result;
}

function safeObject(value) {
  const result = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    if (!OUTPUT_FIELDS.has(key)) continue;
    if (key === "error" && item && typeof item === "object") {
      result.error = {
        classification: ["validation", "product_rework", "release_infrastructure", "external_unknown"].includes(item.classification) ? item.classification : "external_unknown",
        deterministic: item.deterministic === true,
        message: cleanText(item.message),
      };
    } else if (typeof item === "string") result[key] = cleanText(item);
    else if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else if (typeof item === "boolean") result[key] = item;
  }
  return result;
}

function parseJson(value, field) {
  try {
    const parsed = JSON.parse(required(value, field));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed;
  } catch {
    throw new Error(`mini-program configuration ${field} must be a JSON object`);
  }
}

async function assertPrivateRegularFile(filePath, field) {
  const info = await lstat(filePath);
  if (!info.isFile()) throw new Error(`${field} must be a regular file`);
  if ((info.mode & 0o777) !== 0o600) throw new Error(`${field} must be a private 0600 file`);
}

function assertDescriptor(descriptor, environment) {
  if (descriptor.appId !== APP_ID || environment.MINI_PROGRAM_APP_ID !== APP_ID) throw new Error("mini-program App ID does not match the frozen production App ID");
  for (const field of ["version", "reviewConfigurationRef", "sourceDirectory", "artifactDirectory"]) required(descriptor[field], `descriptor.${field}`);
  if (descriptor.version !== environment.MINI_PROGRAM_VERSION) throw new Error("mini-program version does not match frozen descriptor");
  if (descriptor.reviewConfigurationRef !== environment.MINI_PROGRAM_REVIEW_CONFIGURATION_REF) throw new Error("mini-program review configuration reference mismatch");
}

export async function validateStageInputs(environment, { checkFilesystem = true } = {}) {
  for (const key of Object.keys(environment)) {
    if (!ALLOWED_ENV.has(key)) throw new Error(`mini-program configuration has unsupported input ${key}`);
  }
  const stage = required(environment.MINI_PROGRAM_STAGE, "MINI_PROGRAM_STAGE");
  if (!STAGES.has(stage)) throw new Error("mini-program stage is invalid");
  const descriptor = parseJson(environment.MINI_PROGRAM_APP_DESCRIPTOR, "MINI_PROGRAM_APP_DESCRIPTOR");
  assertDescriptor(descriptor, environment);
  const credentialsPath = path.resolve(required(environment.MINI_PROGRAM_CREDENTIALS_PATH, "MINI_PROGRAM_CREDENTIALS_PATH"));
  const reviewConfigurationPath = path.resolve(required(environment.MINI_PROGRAM_REVIEW_CONFIGURATION_PATH, "MINI_PROGRAM_REVIEW_CONFIGURATION_PATH"));
  if (checkFilesystem) {
    await assertPrivateRegularFile(credentialsPath, "mini-program credentials file");
    await assertPrivateRegularFile(reviewConfigurationPath, "mini-program review configuration file");
  }
  const idempotencyKey = String(environment.MINI_PROGRAM_IDEMPOTENCY_KEY ?? "").trim();
  if (MUTATIONS.has(stage) && !idempotencyKey) throw new Error(`${stage} requires stable idempotency identity`);
  const candidateCommit = required(environment.PRODUCTION_CANDIDATE_COMMIT, "PRODUCTION_CANDIDATE_COMMIT");
  if (!/^[0-9a-f]{40}$/.test(candidateCommit)) throw new Error("mini-program Candidate must be a full Git SHA");
  const evidence = parseJson(environment.MINI_PROGRAM_EVIDENCE || "{}", "MINI_PROGRAM_EVIDENCE");
  return {
    stage,
    appId: APP_ID,
    version: descriptor.version,
    app: descriptor,
    credentialsPath,
    reviewConfigurationPath,
    reviewConfigurationRef: descriptor.reviewConfigurationRef,
    idempotencyKey,
    evidence,
    candidateCommit,
    candidateRef: required(environment.PRODUCTION_CANDIDATE_REF, "PRODUCTION_CANDIDATE_REF"),
    manifestChecksum: required(environment.PRODUCTION_MANIFEST_CHECKSUM, "PRODUCTION_MANIFEST_CHECKSUM"),
    versionId: required(environment.PRODUCTION_VERSION_ID, "PRODUCTION_VERSION_ID"),
    repoPath: path.resolve(environment.MINI_PROGRAM_REPO_PATH || "."),
    artifactRoot: path.resolve(environment.MINI_PROGRAM_ARTIFACT_ROOT || path.join(os.tmpdir(), "365wefun-mini-program-artifacts")),
    productionApiAllowlist: environment.MINI_PROGRAM_PRODUCTION_API_ALLOWLIST
      ? JSON.parse(environment.MINI_PROGRAM_PRODUCTION_API_ALLOWLIST)
      : [],
  };
}

async function filesUnder(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error("mini-program artifact must not contain symbolic links");
    if (entry.isDirectory()) files.push(...await filesUnder(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error("mini-program artifact contains a non-regular entry");
  }
  return files;
}

function endpointAllowed(raw, allowlist) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  return allowlist.some((entry) => {
    try {
      const allowed = new URL(entry);
      return url.protocol === "https:" && url.origin === allowed.origin && url.pathname.startsWith(allowed.pathname);
    } catch { return false; }
  });
}

function safeRelative(value, field) {
  const candidate = required(value, field);
  if (path.isAbsolute(candidate) || candidate.includes("\\")
    || candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`mini-program ${field} must be a safe relative path`);
  }
  return candidate;
}

function safeIdentifier(value, field) {
  const candidate = required(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate)) throw new Error(`mini-program ${field} must be a safe path identifier`);
  return candidate;
}

export async function inspectArtifact({
  artifactPath,
  app,
  candidateCommit,
  manifestChecksum,
  productionApiAllowlist,
}) {
  const descriptor = JSON.parse(await readFile(path.join(artifactPath, "project.config.json"), "utf8"));
  if (descriptor.appid !== APP_ID || app.appId !== APP_ID) throw new Error("mini-program artifact App ID mismatch");
  if (!Array.isArray(productionApiAllowlist) || productionApiAllowlist.length === 0) throw new Error("mini-program production API allowlist is required");
  const files = await filesUnder(artifactPath);
  const hash = createHash("sha256");
  let artifactSize = 0;
  for (const relative of files) {
    const content = await readFile(path.join(artifactPath, relative));
    artifactSize += content.length;
    hash.update(Buffer.from(`${relative}\0${content.length}\0`));
    hash.update(content);
    const text = content.toString("utf8");
    if (/-----BEGIN [^-\r\n]*PRIVATE KEY-----|\b(?:authorization|cookie)\s*[:=]|\b(?:api[_-]?key|token|secret|password)\s*[:=]/i.test(text)) {
      throw new Error("mini-program artifact contains secret or private key material");
    }
    const endpoints = text.match(/https?:\/\/[^\s"'`<>\\]+/g) ?? [];
    for (const endpoint of endpoints) {
      if (/(?:^|[./_-])(?:test|debug|staging|localhost|127\.0\.0\.1)(?:[./:_-]|$)/i.test(endpoint)) throw new Error("mini-program artifact contains test or debug endpoint");
      if (!endpointAllowed(endpoint, productionApiAllowlist)) throw new Error("mini-program artifact API is outside the production allowlist");
    }
  }
  const artifactDigest = `sha256:${hash.digest("hex")}`;
  return {
    appId: APP_ID,
    version: required(app.version, "app.version"),
    candidateCommit,
    manifestChecksum,
    artifactDigest,
    artifactSize,
    artifactIdentity: `${APP_ID}:${app.version}:${artifactDigest}`,
    artifactPath,
  };
}

async function defaultRunCommand(file, args, options) {
  return execFile(file, args, { ...options, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
}

export async function buildDetachedCandidate({
  repoPath,
  candidateCommit,
  manifestChecksum,
  app,
  productionApiAllowlist,
  artifactRoot,
  runCommand = defaultRunCommand,
}) {
  if (!/^[0-9a-f]{40}$/.test(candidateCommit)) throw new Error("mini-program Candidate must be a full Git SHA");
  if (app.appId !== APP_ID || app.description !== `Candidate ${candidateCommit}`) throw new Error("mini-program frozen descriptor Candidate/App identity mismatch");
  const sourceDirectory = safeRelative(app.sourceDirectory, "sourceDirectory");
  const artifactDirectory = safeRelative(app.artifactDirectory, "artifactDirectory");
  const appIdentifier = safeIdentifier(app.id, "app.id");
  const manifestIdentifier = safeIdentifier(manifestChecksum, "manifestChecksum");
  const worktreePath = await mkdtemp(path.join(os.tmpdir(), "wechat-candidate-worktree-"));
  let added = false;
  try {
    await runCommand("git", ["worktree", "add", "--detach", worktreePath, candidateCommit], { cwd: repoPath, encoding: "utf8" });
    added = true;
    const commands = [
      ["--filter", "@e365/mp", "lint"],
      ["--filter", "@e365/mp", "typecheck"],
      ["--filter", "@e365/mp", "test"],
      ["--filter", "@e365/mp", "exec", "uni", "build", "-p", "mp-weixin"],
    ];
    for (const args of commands) await runCommand("pnpm", args, { cwd: worktreePath, encoding: "utf8" });
    const builtPath = path.resolve(worktreePath, sourceDirectory, artifactDirectory);
    const inspected = await inspectArtifact({ artifactPath: builtPath, app, candidateCommit, manifestChecksum, productionApiAllowlist });
    const destination = path.resolve(artifactRoot, manifestIdentifier, appIdentifier, inspected.artifactDigest.slice("sha256:".length));
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(builtPath, destination, { recursive: true, errorOnExist: true, force: false });
    return { ...inspected, artifactPath: destination };
  } finally {
    if (added) {
      try { await runCommand("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath, encoding: "utf8" }); } catch {}
    }
    await rm(worktreePath, { recursive: true, force: true });
  }
}

async function loadJson(filePath, readPrivateFile) {
  const value = JSON.parse(await readPrivateFile(filePath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mini-program private descriptor must be an object");
  return value;
}

export async function executeMiniProgramStage(config, {
  readPrivateFile = readFile,
  stageRunner,
  runCommand = defaultRunCommand,
} = {}) {
  if (["test", "build"].includes(config.stage)) {
    return buildDetachedCandidate({ ...config, runCommand });
  }
  if (config.stage === "inspectArtifact") {
    return inspectArtifact({ ...config, artifactPath: config.evidence.artifactPath });
  }
  if (!NETWORK_STAGES.has(config.stage)) throw new Error("mini-program stage is invalid");
  if (typeof stageRunner !== "function") throw new Error("mini-program external stage runner is not injected");
  const credentials = await loadJson(config.credentialsPath, readPrivateFile);
  const reviewConfigurations = await loadJson(config.reviewConfigurationPath, readPrivateFile);
  const reviewConfiguration = reviewConfigurations[config.reviewConfigurationRef];
  if (!reviewConfiguration || typeof reviewConfiguration !== "object" || Array.isArray(reviewConfiguration)) throw new Error("mini-program review configuration reference is missing");
  return stageRunner({ ...config, credentials, reviewConfiguration });
}

export async function runCli({
  environment = process.env,
  write = (value) => process.stdout.write(value),
  validateInputs = validateStageInputs,
  executeStage = executeMiniProgramStage,
} = {}) {
  let final;
  try {
    const config = await validateInputs(environment);
    final = safeObject(await executeStage(config));
  } catch (error) {
    final = { ok: false, error: {
      classification: error?.failureClassification ?? "validation",
      deterministic: error?.deterministic !== false,
      message: cleanText(error?.message),
    } };
  }
  let serialized = JSON.stringify(safeObject(final));
  if (Buffer.byteLength(serialized) > 16 * 1024) serialized = JSON.stringify({ ok: false, error: { classification: "validation", deterministic: true, message: "[REDACTED oversized output]" } });
  write(serialized);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch(() => process.stdout.write('{"ok":false,"error":{"classification":"validation","deterministic":true,"message":"mini-program command failed"}}'));
}

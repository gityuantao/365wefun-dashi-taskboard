#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { redactCredentials } from "../orchestration/domain/redaction.mjs";

const execFile = promisify(execFileCallback);
const APP_ID = "wx1fdac5e27c6b5366";
const STAGES = new Set(["test", "build", "inspectArtifact", "upload", "readUpload", "submitReview", "readReview", "release", "readLive"]);
const LOCAL_STAGES = new Set(["test", "build", "inspectArtifact"]);
const NETWORK_STAGES = new Set(["upload", "readUpload", "submitReview", "readReview", "release", "readLive"]);
const MUTATIONS = new Set(["upload", "submitReview", "release"]);
const ALLOWED_ENV = new Set([
  "PATH", "LANG", "MINI_PROGRAM_STAGE", "MINI_PROGRAM_APP_ID", "MINI_PROGRAM_VERSION",
  "MINI_PROGRAM_APP_IDENTITY", "MINI_PROGRAM_SOURCE_DIRECTORY", "MINI_PROGRAM_ARTIFACT_DIRECTORY",
  "MINI_PROGRAM_DESCRIPTION", "MINI_PROGRAM_CREDENTIALS_PATH",
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

async function openPrivateNoFollow(filePath, field, openFile = open) {
  let handle;
  try {
    handle = await openFile(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error(`${field} must be a non-symlink private descriptor`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${field} must be a regular file`);
    if ((info.mode & 0o777) !== 0o600) throw new Error(`${field} must be a private 0600 file`);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function validatePrivateFileNoFollow(filePath, field) {
  const handle = await openPrivateNoFollow(filePath, field);
  await handle.close();
}

export async function readPrivateJsonNoFollow(filePath, { openFile = open } = {}) {
  const handle = await openPrivateNoFollow(filePath, "mini-program private descriptor", openFile);
  try {
    const value = JSON.parse(await handle.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mini-program private descriptor must be an object");
    return value;
  } finally {
    await handle.close();
  }
}

export async function validateStageInputs(environment, { checkFilesystem = true } = {}) {
  for (const key of Object.keys(environment)) {
    if (!ALLOWED_ENV.has(key)) throw new Error(`mini-program configuration has unsupported input ${key}`);
  }
  const stage = required(environment.MINI_PROGRAM_STAGE, "MINI_PROGRAM_STAGE");
  if (!STAGES.has(stage)) throw new Error("mini-program stage is invalid");
  if (environment.MINI_PROGRAM_APP_ID !== APP_ID) throw new Error("mini-program App ID does not match the frozen production App ID");
  const candidateCommit = required(environment.PRODUCTION_CANDIDATE_COMMIT, "PRODUCTION_CANDIDATE_COMMIT");
  if (!/^[0-9a-f]{40}$/.test(candidateCommit)) throw new Error("mini-program Candidate must be a full Git SHA");
  const evidence = parseJson(environment.MINI_PROGRAM_EVIDENCE || "{}", "MINI_PROGRAM_EVIDENCE");
  const common = {
    stage,
    appId: APP_ID,
    version: required(environment.MINI_PROGRAM_VERSION, "MINI_PROGRAM_VERSION"),
    evidence,
    candidateCommit,
    candidateRef: required(environment.PRODUCTION_CANDIDATE_REF, "PRODUCTION_CANDIDATE_REF"),
    manifestChecksum: required(environment.PRODUCTION_MANIFEST_CHECKSUM, "PRODUCTION_MANIFEST_CHECKSUM"),
    versionId: required(environment.PRODUCTION_VERSION_ID, "PRODUCTION_VERSION_ID"),
  };
  if (LOCAL_STAGES.has(stage)) {
    const app = {
      id: required(environment.MINI_PROGRAM_APP_IDENTITY, "MINI_PROGRAM_APP_IDENTITY"),
      appId: APP_ID,
      version: common.version,
      sourceDirectory: required(environment.MINI_PROGRAM_SOURCE_DIRECTORY, "MINI_PROGRAM_SOURCE_DIRECTORY"),
      artifactDirectory: required(environment.MINI_PROGRAM_ARTIFACT_DIRECTORY, "MINI_PROGRAM_ARTIFACT_DIRECTORY"),
      description: required(environment.MINI_PROGRAM_DESCRIPTION, "MINI_PROGRAM_DESCRIPTION"),
    };
    const productionApiAllowlist = JSON.parse(required(environment.MINI_PROGRAM_PRODUCTION_API_ALLOWLIST, "MINI_PROGRAM_PRODUCTION_API_ALLOWLIST"));
    if (!Array.isArray(productionApiAllowlist) || productionApiAllowlist.length === 0) throw new Error("mini-program production API allowlist is required");
    return { ...common, app, repoPath: path.resolve(required(environment.MINI_PROGRAM_REPO_PATH, "MINI_PROGRAM_REPO_PATH")), artifactRoot: path.resolve(required(environment.MINI_PROGRAM_ARTIFACT_ROOT, "MINI_PROGRAM_ARTIFACT_ROOT")), productionApiAllowlist };
  }
  const credentialsPath = path.resolve(required(environment.MINI_PROGRAM_CREDENTIALS_PATH, "MINI_PROGRAM_CREDENTIALS_PATH"));
  const reviewConfigurationPath = path.resolve(required(environment.MINI_PROGRAM_REVIEW_CONFIGURATION_PATH, "MINI_PROGRAM_REVIEW_CONFIGURATION_PATH"));
  if (checkFilesystem) {
    await validatePrivateFileNoFollow(credentialsPath, "mini-program credentials file");
    await validatePrivateFileNoFollow(reviewConfigurationPath, "mini-program review configuration file");
  }
  const idempotencyKey = String(environment.MINI_PROGRAM_IDEMPOTENCY_KEY ?? "").trim();
  if (MUTATIONS.has(stage) && !idempotencyKey) throw new Error(`${stage} requires stable idempotency identity`);
  return { ...common, credentialsPath, reviewConfigurationPath, reviewConfigurationRef: required(environment.MINI_PROGRAM_REVIEW_CONFIGURATION_REF, "MINI_PROGRAM_REVIEW_CONFIGURATION_REF"), idempotencyKey };
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
      const prefix = allowed.pathname.endsWith("/") ? allowed.pathname.slice(0, -1) : allowed.pathname;
      return url.protocol === "https:" && url.origin === allowed.origin
        && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
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
  artifactRoot,
  artifactPath,
  app,
  candidateCommit,
  manifestChecksum,
  productionApiAllowlist,
}) {
  const canonicalRoot = await canonicalOwnedArtifactRoot(artifactRoot);
  const absoluteArtifact = path.resolve(required(artifactPath, "artifactPath"));
  const artifactInfo = await lstat(absoluteArtifact);
  if (artifactInfo.isSymbolicLink()) throw new Error("mini-program artifactPath must not be a symlink");
  const canonicalArtifact = await realpath(absoluteArtifact);
  const relativeArtifact = path.relative(canonicalRoot, canonicalArtifact);
  if (relativeArtifact === ".." || relativeArtifact.startsWith(`..${path.sep}`) || path.isAbsolute(relativeArtifact)) {
    throw new Error("mini-program artifactPath is outside the owned artifact root");
  }
  artifactPath = canonicalArtifact;
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

async function canonicalExistingRoot(rootPath, field) {
  const absolute = path.resolve(required(rootPath, field));
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const component = await lstat(current);
    if (component.isSymbolicLink()) throw new Error(`mini-program ${field} contains a symlink component`);
  }
  const info = await lstat(absolute);
  const canonical = await realpath(absolute);
  if (!info.isDirectory()) throw new Error(`mini-program ${field} must be a directory`);
  return canonical;
}

async function canonicalOwnedArtifactRoot(rootPath) {
  const absolute = path.resolve(required(rootPath, "artifactRoot"));
  const parent = await canonicalExistingRoot(path.dirname(absolute), "artifactRoot parent");
  const info = await lstat(absolute).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (info?.isSymbolicLink()) throw new Error("mini-program artifactRoot must not be a symlink");
  if (info && !info.isDirectory()) throw new Error("mini-program artifactRoot must be a directory");
  if (!info) await mkdir(absolute, { mode: 0o700 });
  const owned = await lstat(absolute);
  if (typeof process.getuid === "function" && owned.uid !== process.getuid()) throw new Error("mini-program artifactRoot must be owned by the current user");
  if ((owned.mode & 0o777) !== 0o700) throw new Error("mini-program artifactRoot must be a private 0700 directory");
  const canonical = await realpath(absolute);
  if (path.dirname(canonical) !== parent) throw new Error("mini-program artifactRoot must be canonical and owned");
  return canonical;
}

async function assertPathInsideNoSymlinks(root, relative, field) {
  const canonicalRoot = await realpath(root);
  let current = root;
  for (const segment of safeRelative(relative, field).split("/")) {
    current = path.join(current, segment);
    const info = await lstat(current).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) break;
    if (info.isSymbolicLink()) throw new Error(`mini-program ${field} contains a symlink component`);
    const canonical = await realpath(current);
    if (path.relative(canonicalRoot, canonical).startsWith("..")) throw new Error(`mini-program ${field} escapes its canonical root`);
  }
}

async function runSandboxed(sandboxRunner, command, worktreePath) {
  if (typeof sandboxRunner !== "function") throw new Error("mini-program local execution requires a no-network sandbox runner");
  const proof = await sandboxRunner({
    file: "pnpm", args: command, cwd: worktreePath,
    env: { PATH: process.env.PATH ?? "", LANG: process.env.LANG ?? "C.UTF-8" },
    network: "disabled",
  });
  if (proof?.networkDisabled !== true) throw new Error("mini-program sandbox did not prove network disabled");
  return proof.result;
}

async function withDetachedCandidate({ repoPath, candidateCommit, runCommand, operation }) {
  const canonicalRepo = await canonicalExistingRoot(repoPath, "repoPath");
  const worktreePath = await mkdtemp(path.join(os.tmpdir(), "wechat-candidate-worktree-"));
  let added = false;
  let operationError;
  let result;
  try {
    await runCommand("git", ["worktree", "add", "--detach", worktreePath, candidateCommit], { cwd: canonicalRepo, encoding: "utf8" });
    added = true;
    result = await operation(worktreePath, canonicalRepo);
  } catch (error) {
    operationError = error;
  }
  let cleanupError;
  if (added) {
    try {
      await runCommand("git", ["worktree", "remove", "--force", worktreePath], { cwd: canonicalRepo, encoding: "utf8" });
    } catch (error) { cleanupError = error; }
    try {
      const listing = await runCommand("git", ["worktree", "list", "--porcelain"], { cwd: canonicalRepo, encoding: "utf8" });
      if (String(listing?.stdout ?? "").includes(worktreePath)) throw new Error("git worktree registry still contains the detached Candidate");
    } catch (error) { cleanupError ??= error; }
  }
  await rm(worktreePath, { recursive: true, force: true });
  if (cleanupError) throw new Error(`mini-program worktree cleanup failed: ${cleanText(cleanupError.message)}`);
  if (operationError) throw operationError;
  return result;
}

function validateCandidateIdentity({ candidateCommit, manifestChecksum, app }) {
  if (!/^[0-9a-f]{40}$/.test(candidateCommit)) throw new Error("mini-program Candidate must be a full Git SHA");
  if (app.appId !== APP_ID || app.description !== `Candidate ${candidateCommit}`) throw new Error("mini-program frozen descriptor Candidate/App identity mismatch");
  return {
    sourceDirectory: safeRelative(app.sourceDirectory, "sourceDirectory"),
    artifactDirectory: safeRelative(app.artifactDirectory, "artifactDirectory"),
    appIdentifier: safeIdentifier(app.id, "app.id"),
    manifestIdentifier: safeIdentifier(manifestChecksum, "manifestChecksum"),
  };
}

export async function validateDetachedCandidate({ repoPath, candidateCommit, manifestChecksum, app, runCommand = defaultRunCommand, sandboxRunner }) {
  validateCandidateIdentity({ candidateCommit, manifestChecksum, app });
  if (typeof sandboxRunner !== "function") throw new Error("mini-program local execution requires a no-network sandbox runner");
  return withDetachedCandidate({ repoPath, candidateCommit, runCommand, operation: async (worktreePath) => {
    for (const args of [["--filter", "@e365/mp", "lint"], ["--filter", "@e365/mp", "typecheck"], ["--filter", "@e365/mp", "test"]]) {
      await runSandboxed(sandboxRunner, args, worktreePath);
    }
    return { appId: APP_ID, version: app.version, candidateCommit, manifestChecksum, status: "validated" };
  } });
}

export async function buildDetachedCandidate({
  repoPath,
  candidateCommit,
  manifestChecksum,
  app,
  productionApiAllowlist,
  artifactRoot,
  runCommand = defaultRunCommand,
  sandboxRunner,
  copyArtifact = (source, target) => cp(source, target, { recursive: true, errorOnExist: true, force: false }),
}) {
  const identity = validateCandidateIdentity({ candidateCommit, manifestChecksum, app });
  if (typeof sandboxRunner !== "function") throw new Error("mini-program local execution requires a no-network sandbox runner");
  const canonicalArtifacts = await canonicalOwnedArtifactRoot(artifactRoot);
  return withDetachedCandidate({ repoPath, candidateCommit, runCommand, operation: async (worktreePath) => {
    await assertPathInsideNoSymlinks(worktreePath, identity.sourceDirectory, "sourceDirectory");
    const commands = [["--filter", "@e365/mp", "exec", "uni", "build", "-p", "mp-weixin"]];
    for (const args of commands) await runSandboxed(sandboxRunner, args, worktreePath);
    const builtRelative = path.join(identity.sourceDirectory, identity.artifactDirectory);
    await assertPathInsideNoSymlinks(worktreePath, builtRelative, "artifactDirectory");
    const builtPath = path.resolve(worktreePath, builtRelative);
    const privateCopy = await mkdtemp(path.join(canonicalArtifacts, ".candidate-copy-"));
    const copiedArtifact = path.join(privateCopy, "artifact");
    try {
      await copyArtifact(builtPath, copiedArtifact);
      const inspected = await inspectArtifact({ artifactRoot: canonicalArtifacts, artifactPath: copiedArtifact, app, candidateCommit, manifestChecksum, productionApiAllowlist });
      const parent = path.join(canonicalArtifacts, identity.manifestIdentifier, identity.appIdentifier);
      const destination = path.join(parent, inspected.artifactDigest.slice("sha256:".length));
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await rename(copiedArtifact, destination);
      return { ...inspected, artifactPath: destination };
    } finally { await rm(privateCopy, { recursive: true, force: true }); }
  } });
}

export async function executeMiniProgramStage(config, {
  readPrivateFile,
  stageRunner,
  runCommand = defaultRunCommand,
  sandboxRunner,
} = {}) {
  if (config.stage === "test") return validateDetachedCandidate({ ...config, runCommand, sandboxRunner });
  if (config.stage === "build") return buildDetachedCandidate({ ...config, runCommand, sandboxRunner });
  if (config.stage === "inspectArtifact") {
    return inspectArtifact({ ...config, artifactPath: config.evidence.artifactPath });
  }
  if (!NETWORK_STAGES.has(config.stage)) throw new Error("mini-program stage is invalid");
  if (typeof stageRunner !== "function") throw new Error("mini-program external stage runner is not injected");
  const loader = readPrivateFile
    ? (filePath) => readPrivateFile(filePath, "utf8").then((value) => JSON.parse(value))
    : (filePath) => readPrivateJsonNoFollow(filePath);
  const credentials = await loader(config.credentialsPath);
  const reviewConfigurations = await loader(config.reviewConfigurationPath);
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
    const unknownMutation = MUTATIONS.has(environment?.MINI_PROGRAM_STAGE)
      || MUTATIONS.has(error?.stage);
    final = { ok: false, error: {
      classification: error?.failureClassification ?? (unknownMutation ? "external_unknown" : "validation"),
      deterministic: error?.deterministic === true || (!unknownMutation && error?.deterministic !== false),
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

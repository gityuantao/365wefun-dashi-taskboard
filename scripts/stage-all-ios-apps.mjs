#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const STAGING_API_URL = "https://test-api.365english.online";
const APP_STORE_CONNECT_ORIGIN = "https://api.appstoreconnect.apple.com";
const BUILD_CONFIGURATION = "Staging";
const DEFAULT_TEST_DESTINATION = "platform=iOS Simulator,name=iPhone 17 Pro";
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_READBACK_TIMEOUT_MS = 25 * 60_000;
const COMMAND_MAX_BUFFER = 256 * 1024 * 1024;
const DEBUG_HOOK_MARKERS = Object.freeze([
  "E365_UI_TEST_IAP_MODE",
  "QuickLessonUITestIAPAPI",
  "E365ForceChinaStore",
]);
const SENSITIVE_COMMAND_OPTIONS = new Set([
  "--api-key",
  "--api-issuer",
  "-apiKey",
  "-apiIssuer",
  "--auth-string",
  "-jwt",
]);

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`iOS staging configuration missing ${field}`);
  }
  return value.trim();
}

function requirePositiveInteger(value, field) {
  const normalized = requireString(String(value ?? ""), field);
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`iOS staging configuration ${field} must be a positive integer`);
  }
  return normalized;
}

function parsePositiveNumber(value, fallback, field) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`iOS staging configuration ${field} must be a positive number`);
  }
  return number;
}

function assertSafeIdentifier(value, field) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`iOS staging configuration ${field} contains unsafe characters`);
  }
}

function quoteArgument(value) {
  const text = String(value);
  if (text === "[REDACTED]") return text;
  return /^[A-Za-z0-9_./:=,+-]+$/.test(text) ? text : JSON.stringify(text);
}

export function redactCommand(command) {
  const safe = [];
  let redactNext = false;
  for (const part of command.args ?? []) {
    if (redactNext) {
      safe.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    safe.push(String(part));
    if (SENSITIVE_COMMAND_OPTIONS.has(String(part))) redactNext = true;
  }
  return [command.file, ...safe].map(quoteArgument).join(" ");
}

export function createBuildPaths({ candidatePath, artifactsRoot, app }) {
  const appId = requireString(app?.id, "IOS_APP_ID");
  const scheme = requireString(app?.scheme, "IOS_SCHEME");
  assertSafeIdentifier(appId, "IOS_APP_ID");
  assertSafeIdentifier(scheme, "IOS_SCHEME");
  const iosDirectory = path.join(candidatePath, "apps", "ios");
  const appRoot = path.join(artifactsRoot, appId);
  return {
    iosDirectory,
    projectPath: path.join(iosDirectory, "E365.xcodeproj"),
    appRoot,
    derivedDataPath: path.join(appRoot, "DerivedData"),
    archivePath: path.join(appRoot, `${scheme}.xcarchive`),
    exportPath: path.join(appRoot, "export"),
    exportOptionsPath: path.join(appRoot, "ExportOptions.plist"),
    ipaExpansionPath: path.join(appRoot, "ipa-expanded"),
  };
}

function buildIdentitySettings({ app, marketingVersion, buildNumber, apiUrl }) {
  return [
    `MARKETING_VERSION=${marketingVersion}`,
    `CURRENT_PROJECT_VERSION=${buildNumber}`,
    `PRODUCT_BUNDLE_IDENTIFIER=${app.bundleId}`,
    `API_BASE_URL=${apiUrl}`,
  ];
}

export function buildBuildSettingsCommand(context) {
  return {
    file: "xcodebuild",
    args: [
      "-project", context.paths.projectPath,
      "-target", context.app.scheme,
      "-configuration", BUILD_CONFIGURATION,
      "-showBuildSettings",
      ...buildIdentitySettings(context),
    ],
    cwd: context.paths.iosDirectory,
  };
}

export function buildTestCommand(context) {
  return {
    file: "xcodebuild",
    args: [
      "test",
      "-project", context.paths.projectPath,
      "-scheme", context.app.scheme,
      "-configuration", BUILD_CONFIGURATION,
      "-destination", context.testDestination,
      "-derivedDataPath", context.paths.derivedDataPath,
      `API_BASE_URL=${context.apiUrl}`,
    ],
    cwd: context.paths.iosDirectory,
  };
}

export function buildArchiveCommand(context) {
  return {
    file: "xcodebuild",
    args: [
      "archive",
      "-project", context.paths.projectPath,
      "-scheme", context.app.scheme,
      "-configuration", BUILD_CONFIGURATION,
      "-destination", "generic/platform=iOS",
      "-archivePath", context.paths.archivePath,
      "-derivedDataPath", context.paths.derivedDataPath,
      "-allowProvisioningUpdates",
      ...buildIdentitySettings(context),
    ],
    cwd: context.paths.iosDirectory,
  };
}

export function buildExportCommand(context) {
  return {
    file: "xcodebuild",
    args: [
      "-exportArchive",
      "-archivePath", context.paths.archivePath,
      "-exportPath", context.paths.exportPath,
      "-exportOptionsPlist", context.paths.exportOptionsPath,
      "-allowProvisioningUpdates",
    ],
    cwd: context.paths.iosDirectory,
  };
}

export function buildUploadCommand({ ipaPath, keyId, issuerId, privateKeyPath }) {
  return {
    file: "xcrun",
    args: [
      "altool", "--upload-app",
      "-f", ipaPath,
      "--api-key", keyId,
      "--api-issuer", issuerId,
      "--output-format", "json",
    ],
    env: { API_PRIVATE_KEYS_DIR: path.dirname(privateKeyPath) },
  };
}

function buildXcodegenCommand(paths) {
  return {
    file: "xcodegen",
    args: ["generate", "--spec", "project.yml"],
    cwd: paths.iosDirectory,
  };
}

function buildUnzipCommand(ipaPath, paths) {
  return {
    file: "unzip",
    args: ["-q", ipaPath, "-d", paths.ipaExpansionPath],
    cwd: paths.appRoot,
  };
}

export function verifyArtifactIdentity(actual, expected, source) {
  const normalized = {
    bundleId: String(actual?.bundleId ?? ""),
    marketingVersion: String(actual?.marketingVersion ?? ""),
    buildNumber: String(actual?.buildNumber ?? ""),
    apiUrl: String(actual?.apiUrl ?? ""),
  };
  for (const field of ["bundleId", "marketingVersion", "buildNumber", "apiUrl"]) {
    if (normalized[field] !== String(expected[field])) {
      throw new Error(`${source} artifact ${field} does not exactly match the requested App`);
    }
  }
  return normalized;
}

export function assertDebugHooksAbsent(binary, source) {
  const content = Buffer.isBuffer(binary) ? binary.toString("latin1") : String(binary ?? "");
  const marker = DEBUG_HOOK_MARKERS.find((candidate) => content.includes(candidate));
  if (marker) {
    throw new Error(`${source} contains a compiled debug hook and is not safe for TestFlight`);
  }
}

export function buildExactBuildQuery({ appResourceId, marketingVersion, buildNumber }) {
  const query = new URLSearchParams();
  query.set("filter[app]", appResourceId);
  query.set("filter[preReleaseVersion.version]", marketingVersion);
  query.set("filter[version]", buildNumber);
  query.set("limit", "2");
  return `/v1/builds?${query}`;
}

export function buildGroupQuery({ appResourceId, groupName }) {
  const query = new URLSearchParams();
  query.set("filter[app]", appResourceId);
  query.set("filter[name]", groupName);
  query.set("filter[isInternalGroup]", "true");
  query.set("limit", "2");
  return `/v1/betaGroups?${query}`;
}

export function buildGroupMembershipRequest({ groupId, buildId }) {
  return {
    path: `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`,
    method: "POST",
    body: { data: [{ type: "builds", id: buildId }] },
  };
}

export function nextBuildNumberFromBuilds(builds) {
  let maximum = 0;
  for (const build of builds) {
    const version = String(build?.attributes?.version ?? "");
    if (!/^[1-9]\d*$/.test(version)) {
      throw new Error("App Store Connect contains a non-integer build number; strict App sequencing cannot be proven");
    }
    maximum = Math.max(maximum, Number(version));
  }
  if (!Number.isSafeInteger(maximum) || maximum >= Number.MAX_SAFE_INTEGER) {
    throw new Error("App Store Connect build number exceeds the safe integer range");
  }
  return String(maximum + 1);
}

export function validateEnvironment(environment, mode, { checkFilesystem = true } = {}) {
  if (mode !== "stage" && mode !== "readback") {
    throw new Error('iOS staging mode must be "stage" or "readback"');
  }
  const dryRun = environment.IOS_STAGING_DRY_RUN === "1";
  const config = {
    mode,
    dryRun,
    app: {
      id: requireString(environment.IOS_APP_ID, "IOS_APP_ID"),
      scheme: requireString(environment.IOS_SCHEME, "IOS_SCHEME"),
      bundleId: requireString(environment.IOS_BUNDLE_ID, "IOS_BUNDLE_ID"),
      testFlightGroup: requireString(environment.IOS_TESTFLIGHT_GROUP, "IOS_TESTFLIGHT_GROUP"),
    },
    marketingVersion: requireString(environment.IOS_MARKETING_VERSION, "IOS_MARKETING_VERSION"),
    candidateCommit: requireString(environment.STAGING_CANDIDATE_COMMIT, "STAGING_CANDIDATE_COMMIT").toLowerCase(),
    repoPath: requireString(environment.STAGING_REPO_PATH, "STAGING_REPO_PATH"),
    testDestination: environment.IOS_TEST_DESTINATION?.trim() || DEFAULT_TEST_DESTINATION,
    pollIntervalMs: parsePositiveNumber(
      environment.IOS_TESTFLIGHT_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      "IOS_TESTFLIGHT_POLL_INTERVAL_MS",
    ),
    readbackTimeoutMs: parsePositiveNumber(
      environment.IOS_TESTFLIGHT_READBACK_TIMEOUT_MS,
      DEFAULT_READBACK_TIMEOUT_MS,
      "IOS_TESTFLIGHT_READBACK_TIMEOUT_MS",
    ),
  };
  assertSafeIdentifier(config.app.id, "IOS_APP_ID");
  assertSafeIdentifier(config.app.scheme, "IOS_SCHEME");
  if (!/^[A-Za-z0-9.-]+$/.test(config.app.bundleId) || !config.app.bundleId.includes(".")) {
    throw new Error("iOS staging configuration IOS_BUNDLE_ID is invalid");
  }
  if (!/^\d+(?:\.\d+){1,2}$/.test(config.marketingVersion)) {
    throw new Error("iOS staging configuration IOS_MARKETING_VERSION is invalid");
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(config.candidateCommit)) {
    throw new Error("iOS staging configuration STAGING_CANDIDATE_COMMIT must be a full Git commit ID");
  }
  if (mode === "readback") {
    config.buildNumber = requirePositiveInteger(environment.IOS_BUILD_NUMBER, "IOS_BUILD_NUMBER");
    config.uploadId = requireString(environment.IOS_UPLOAD_ID, "IOS_UPLOAD_ID");
  }

  if (!dryRun) {
    config.apple = {
      keyId: requireString(environment.ASC_KEY_ID, "ASC_KEY_ID"),
      issuerId: requireString(environment.ASC_ISSUER_ID, "ASC_ISSUER_ID"),
      privateKeyPath: path.resolve(requireString(environment.ASC_PRIVATE_KEY_PATH, "ASC_PRIVATE_KEY_PATH")),
    };
    assertSafeIdentifier(config.apple.keyId, "ASC_KEY_ID");
    const expectedPrivateKeyName = `AuthKey_${config.apple.keyId}.p8`;
    if (path.basename(config.apple.privateKeyPath) !== expectedPrivateKeyName) {
      throw new Error(`ASC_PRIVATE_KEY_PATH must name ${expectedPrivateKeyName}`);
    }
    if (checkFilesystem) {
      if (!fs.existsSync(config.apple.privateKeyPath) || !fs.statSync(config.apple.privateKeyPath).isFile()) {
        throw new Error("ASC_PRIVATE_KEY_PATH does not point to a readable private key file");
      }
      const permissions = fs.statSync(config.apple.privateKeyPath).mode & 0o777;
      if ((permissions & 0o077) !== 0) {
        throw new Error("ASC_PRIVATE_KEY_PATH must not grant group or other permissions");
      }
      if (!fs.existsSync(config.repoPath)) {
        throw new Error("STAGING_REPO_PATH does not exist");
      }
    }
  }
  return config;
}

async function runCommand(command, label = command.file) {
  console.log(`$ ${redactCommand(command)}`);
  try {
    return await execFile(command.file, command.args ?? [], {
      cwd: command.cwd,
      encoding: "utf8",
      env: { ...process.env, ...(command.env ?? {}) },
      maxBuffer: COMMAND_MAX_BUFFER,
    });
  } catch (error) {
    const status = Number.isInteger(error?.code) ? `exit ${error.code}` : "execution error";
    throw new Error(`${label} failed (${status})`);
  }
}

export async function withCandidateWorktree({ repoPath, candidateCommit, temporaryRoot, operation }) {
  const ownsTemporaryRoot = temporaryRoot === undefined;
  const root = temporaryRoot ?? await mkdtemp(path.join(os.tmpdir(), "ios-staging-"));
  const candidatePath = path.join(root, "candidate");
  if (fs.existsSync(candidatePath)) {
    throw new Error("Candidate worktree path already exists; refusing to overwrite it");
  }
  let added = false;
  let operationError;
  let result;
  try {
    const resolved = await runCommand({
      file: "git",
      args: ["-C", repoPath, "rev-parse", "--verify", `${candidateCommit}^{commit}`],
    }, "Candidate commit validation");
    if (resolved.stdout.trim().toLowerCase() !== candidateCommit.toLowerCase()) {
      throw new Error("Candidate commit did not resolve to the exact requested commit");
    }
    await runCommand({
      file: "git",
      args: ["-C", repoPath, "worktree", "add", "--detach", candidatePath, candidateCommit],
    }, "Candidate worktree creation");
    added = true;
    result = await operation(candidatePath, root);
  } catch (error) {
    operationError = error;
  } finally {
    if (added) {
      try {
        await runCommand({
          file: "git",
          args: ["-C", repoPath, "worktree", "remove", "--force", candidatePath],
        }, "Candidate worktree cleanup");
      } catch (cleanupError) {
        if (!operationError) operationError = cleanupError;
      }
    }
    if (fs.existsSync(candidatePath)) {
      try {
        await rm(candidatePath, { recursive: true, force: true });
      } catch (cleanupError) {
        if (!operationError) operationError = cleanupError;
      }
    }
    if (ownsTemporaryRoot) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (cleanupError) {
        if (!operationError) operationError = cleanupError;
      }
    }
  }
  if (operationError) throw operationError;
  return result;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function createJwt({ keyId, issuerId, privateKey }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: issuerId,
    iat: now,
    exp: now + 15 * 60,
    aud: "appstoreconnect-v1",
  }));
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function validateApiUrl(value) {
  const url = new URL(value, APP_STORE_CONNECT_ORIGIN);
  if (url.origin !== APP_STORE_CONNECT_ORIGIN) {
    throw new Error("App Store Connect pagination attempted to leave the Apple API origin");
  }
  return url;
}

async function createAppStoreConnectClient(apple) {
  const privateKeyPem = await readFile(apple.privateKeyPath, "utf8");
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    throw new Error("ASC_PRIVATE_KEY_PATH does not contain a valid signing key");
  }

  async function request(requestPath, { method = "GET", body } = {}) {
    const url = validateApiUrl(requestPath);
    let response;
    try {
      response = await fetch(url, {
        method,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${createJwt({ ...apple, privateKey })}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error("App Store Connect request failed before a response was received");
    }
    if (!response.ok) {
      throw new Error(`App Store Connect request failed with HTTP ${response.status}`);
    }
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new Error("App Store Connect returned malformed JSON");
    }
  }

  async function listAll(requestPath) {
    const resources = [];
    let next = requestPath;
    while (next) {
      const response = await request(next);
      if (!Array.isArray(response?.data)) {
        throw new Error("App Store Connect list response is missing data");
      }
      resources.push(...response.data);
      next = response?.links?.next ?? null;
      if (next) validateApiUrl(next);
    }
    return resources;
  }

  return {
    async findApp(bundleId) {
      const query = new URLSearchParams({ "filter[bundleId]": bundleId, limit: "2" });
      const apps = await listAll(`/v1/apps?${query}`);
      if (apps.length !== 1 || apps[0]?.attributes?.bundleId !== bundleId) {
        throw new Error("App Store Connect did not return exactly one matching bundle ID");
      }
      return apps[0];
    },
    async listBuilds(appResourceId) {
      const query = new URLSearchParams({ "filter[app]": appResourceId, limit: "200" });
      return listAll(`/v1/builds?${query}`);
    },
    async findExactBuild({ appResourceId, marketingVersion, buildNumber }) {
      const response = await request(buildExactBuildQuery({ appResourceId, marketingVersion, buildNumber }));
      if (!Array.isArray(response?.data)) {
        throw new Error("App Store Connect exact build response is missing data");
      }
      if (response.data.length === 0) return null;
      if (response.data.length !== 1 || String(response.data[0]?.attributes?.version ?? "") !== buildNumber) {
        throw new Error("App Store Connect did not return exactly one matching build");
      }
      return response.data[0];
    },
    async findExactInternalGroup({ appResourceId, groupName }) {
      const response = await request(buildGroupQuery({ appResourceId, groupName }));
      if (!Array.isArray(response?.data) || response.data.length !== 1) {
        throw new Error("App Store Connect did not return exactly one matching Internal Testing group");
      }
      const group = response.data[0];
      if (group?.attributes?.name !== groupName || group?.attributes?.isInternalGroup !== true) {
        throw new Error("App Store Connect group is not the exact configured internal group");
      }
      return group;
    },
    async groupHasBuild(groupId, buildId) {
      const builds = await listAll(`/v1/betaGroups/${encodeURIComponent(groupId)}/builds?limit=200`);
      return builds.some((build) => build?.id === buildId);
    },
    async addBuildToGroup(groupId, buildId) {
      const linkage = buildGroupMembershipRequest({ groupId, buildId });
      await request(linkage.path, { method: linkage.method, body: linkage.body });
    },
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertWithinDeadline(startedAt, timeoutMs, stage) {
  if (Date.now() - startedAt >= timeoutMs) {
    throw new Error(`TestFlight ${stage} timed out before authoritative confirmation`);
  }
}

export async function ensureProcessedAndInGroup({
  client,
  appResourceId,
  bundleId,
  marketingVersion,
  buildNumber,
  groupName,
  timeoutMs,
  pollIntervalMs,
  sleep = delay,
  now = () => new Date(),
}) {
  const startedAt = Date.now();
  let build;
  while (true) {
    assertWithinDeadline(startedAt, timeoutMs, "processing");
    build = await client.findExactBuild({ appResourceId, marketingVersion, buildNumber });
    const state = build?.attributes?.processingState;
    if (state === "VALID") break;
    if (state === "FAILED" || state === "INVALID") {
      throw new Error("TestFlight build processing failed");
    }
    await sleep(pollIntervalMs);
  }

  const group = await client.findExactInternalGroup({ appResourceId, groupName });
  if (!await client.groupHasBuild(group.id, build.id)) {
    await client.addBuildToGroup(group.id, build.id);
  }
  while (!await client.groupHasBuild(group.id, build.id)) {
    assertWithinDeadline(startedAt, timeoutMs, "Internal Testing membership");
    await sleep(pollIntervalMs);
  }

  return {
    bundleId,
    marketingVersion,
    buildNumber,
    processed: true,
    processingStatus: "processed",
    testGroup: groupName,
    membershipConfirmed: true,
    checkedAt: now().toISOString(),
  };
}

function parseBuildSettings(stdout) {
  const settings = {};
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) settings[match[1]] = match[2];
  }
  return settings;
}

function verifyBuildSettings(settings, context) {
  const expected = {
    CONFIGURATION: BUILD_CONFIGURATION,
    PRODUCT_BUNDLE_IDENTIFIER: context.app.bundleId,
    MARKETING_VERSION: context.marketingVersion,
    CURRENT_PROJECT_VERSION: context.buildNumber,
    API_BASE_URL: context.apiUrl,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (settings[field] !== value) {
      throw new Error(`Xcode preflight ${field} does not match the requested App`);
    }
  }
  const conditions = String(settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS ?? "")
    .split(/\s+/)
    .filter(Boolean);
  if (conditions.includes("DEBUG")) {
    throw new Error("Xcode preflight found DEBUG compilation conditions in Staging");
  }
  if (settings.SWIFT_OPTIMIZATION_LEVEL === "-Onone") {
    throw new Error("Xcode preflight found a debug optimization level in Staging");
  }
}

async function writeExportOptions(exportOptionsPath) {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>destination</key><string>export</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>method</key><string>app-store-connect</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
`;
  await writeFile(exportOptionsPath, plist, { encoding: "utf8", mode: 0o600 });
}

async function readPlist(plistPath) {
  const result = await runCommand({
    file: "plutil",
    args: ["-convert", "json", "-o", "-", plistPath],
  }, "Info.plist inspection");
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Info.plist inspection returned malformed JSON");
  }
}

async function findSingleEntry(directory, predicate, description) {
  const entries = (await readdir(directory, { withFileTypes: true })).filter(predicate);
  if (entries.length !== 1) {
    throw new Error(`Expected exactly one ${description}`);
  }
  return path.join(directory, entries[0].name);
}

async function findForbiddenStoreKitConfiguration(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      if (entry.name.endsWith(".storekit")) return entryPath;
    }
  }
  return null;
}

async function verifyAppBundle(appBundlePath, context, source) {
  const plist = await readPlist(path.join(appBundlePath, "Info.plist"));
  const identity = verifyArtifactIdentity({
    bundleId: plist.CFBundleIdentifier,
    marketingVersion: plist.CFBundleShortVersionString,
    buildNumber: plist.CFBundleVersion,
    apiUrl: plist.API_BASE_URL,
  }, {
    bundleId: context.app.bundleId,
    marketingVersion: context.marketingVersion,
    buildNumber: context.buildNumber,
    apiUrl: context.apiUrl,
  }, source);
  const executable = requireString(plist.CFBundleExecutable, `${source} CFBundleExecutable`);
  const binaryPath = path.join(appBundlePath, executable);
  if (!fs.existsSync(binaryPath) || !(await stat(binaryPath)).isFile()) {
    throw new Error(`${source} executable is missing`);
  }
  assertDebugHooksAbsent(await readFile(binaryPath), source);
  if (await findForbiddenStoreKitConfiguration(appBundlePath)) {
    throw new Error(`${source} contains a debug StoreKit configuration`);
  }
  return identity;
}

export function extractUploadIdentifier(stdout, fallback) {
  let value;
  try {
    value = JSON.parse(String(stdout).trim());
  } catch {
    throw new Error("App Store upload did not return JSON evidence");
  }
  if (Array.isArray(value?.["product-errors"]) && value["product-errors"].length > 0) {
    throw new Error("App Store upload returned product errors");
  }
  const candidateKeys = new Set([
    "delivery-uuid",
    "deliveryUuid",
    "requestUUID",
    "requestUuid",
    "upload-id",
    "uploadId",
  ]);
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || typeof current !== "object") continue;
    for (const [key, item] of Object.entries(current)) {
      if (candidateKeys.has(key) && typeof item === "string" && item.trim()) return item.trim();
      if (item && typeof item === "object") pending.push(item);
    }
  }
  if (!value || typeof value !== "object") {
    throw new Error("App Store upload did not return an evidence object");
  }
  return fallback;
}

async function stage(config) {
  const client = await createAppStoreConnectClient(config.apple);
  return withCandidateWorktree({
    repoPath: config.repoPath,
    candidateCommit: config.candidateCommit,
    async operation(candidatePath, temporaryRoot) {
      const initialPaths = createBuildPaths({
        candidatePath,
        artifactsRoot: path.join(temporaryRoot, "artifacts"),
        app: config.app,
      });
      await mkdir(initialPaths.appRoot, { recursive: true });
      await runCommand(buildXcodegenCommand(initialPaths), "XcodeGen");

      const appResource = await client.findApp(config.app.bundleId);
      const buildNumber = nextBuildNumberFromBuilds(await client.listBuilds(appResource.id));
      const context = {
        app: config.app,
        paths: initialPaths,
        marketingVersion: config.marketingVersion,
        buildNumber,
        testDestination: config.testDestination,
        apiUrl: STAGING_API_URL,
      };
      const buildSettings = await runCommand(buildBuildSettingsCommand(context), "Xcode Staging preflight");
      verifyBuildSettings(parseBuildSettings(buildSettings.stdout), context);
      await runCommand(buildTestCommand(context), `${config.app.scheme} tests`);
      await runCommand(buildArchiveCommand(context), `${config.app.scheme} archive`);

      const archiveApplications = path.join(context.paths.archivePath, "Products", "Applications");
      const archiveApp = await findSingleEntry(
        archiveApplications,
        (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
        "archived .app",
      );
      const archiveIdentity = await verifyAppBundle(archiveApp, context, "archive");

      await mkdir(context.paths.exportPath, { recursive: true });
      await writeExportOptions(context.paths.exportOptionsPath);
      await runCommand(buildExportCommand(context), `${config.app.scheme} export`);
      const ipaPath = await findSingleEntry(
        context.paths.exportPath,
        (entry) => entry.isFile() && entry.name.endsWith(".ipa"),
        "exported IPA",
      );
      await rm(context.paths.ipaExpansionPath, { recursive: true, force: true });
      await mkdir(context.paths.ipaExpansionPath, { recursive: true });
      await runCommand(buildUnzipCommand(ipaPath, context.paths), "IPA expansion");
      const ipaApp = await findSingleEntry(
        path.join(context.paths.ipaExpansionPath, "Payload"),
        (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
        "IPA Payload .app",
      );
      const ipaIdentity = await verifyAppBundle(ipaApp, context, "IPA");
      if (JSON.stringify(archiveIdentity) !== JSON.stringify(ipaIdentity)) {
        throw new Error("Archive and IPA identities do not exactly match");
      }

      const upload = await runCommand(buildUploadCommand({
        ipaPath,
        keyId: config.apple.keyId,
        issuerId: config.apple.issuerId,
        privateKeyPath: config.apple.privateKeyPath,
      }), "App Store upload");
      const fallbackUploadId = `asc:${appResource.id}:${config.marketingVersion}:${buildNumber}`;
      return {
        appId: config.app.id,
        scheme: config.app.scheme,
        bundleId: config.app.bundleId,
        marketingVersion: config.marketingVersion,
        buildNumber,
        uploadId: extractUploadIdentifier(upload.stdout, fallbackUploadId),
      };
    },
  });
}

async function readback(config) {
  const client = await createAppStoreConnectClient(config.apple);
  const appResource = await client.findApp(config.app.bundleId);
  return ensureProcessedAndInGroup({
    client,
    appResourceId: appResource.id,
    bundleId: config.app.bundleId,
    marketingVersion: config.marketingVersion,
    buildNumber: config.buildNumber,
    groupName: config.app.testFlightGroup,
    timeoutMs: config.readbackTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
  });
}

function dryRun(config) {
  const buildNumber = requirePositiveInteger(
    process.env.IOS_STAGING_DRY_RUN_BUILD_NUMBER ?? "1",
    "IOS_STAGING_DRY_RUN_BUILD_NUMBER",
  );
  if (config.mode === "readback") {
    throw new Error("dry-run readback cannot provide authoritative TestFlight evidence");
  }
  const candidatePath = path.join(os.tmpdir(), "ios-staging-dry-run", config.app.id, "candidate");
  const paths = createBuildPaths({
    candidatePath,
    artifactsRoot: path.join(os.tmpdir(), "ios-staging-dry-run", config.app.id, "artifacts"),
    app: config.app,
  });
  const context = {
    app: config.app,
    paths,
    marketingVersion: config.marketingVersion,
    buildNumber,
    testDestination: config.testDestination,
    apiUrl: STAGING_API_URL,
  };
  const commands = [
    buildXcodegenCommand(paths),
    buildBuildSettingsCommand(context),
    buildTestCommand(context),
    buildArchiveCommand(context),
    buildExportCommand(context),
    buildUploadCommand({
      ipaPath: path.join(paths.exportPath, `${config.app.scheme}.ipa`),
      keyId: process.env.ASC_KEY_ID ?? "unconfigured",
      issuerId: process.env.ASC_ISSUER_ID ?? "unconfigured",
      privateKeyPath: process.env.ASC_PRIVATE_KEY_PATH ?? path.join(os.tmpdir(), "AuthKey_unconfigured.p8"),
    }),
  ].map(redactCommand);
  for (const command of commands) console.log(`DRY RUN $ ${command}`);
  return {
    dryRun: true,
    mode: "stage",
    appId: config.app.id,
    scheme: config.app.scheme,
    bundleId: config.app.bundleId,
    marketingVersion: config.marketingVersion,
    buildNumber,
    uploadId: `dry-run-${config.app.id}-${config.marketingVersion}-${buildNumber}`,
    commands,
  };
}

async function main() {
  const mode = process.argv[2];
  const config = validateEnvironment(process.env, mode);
  const evidence = config.dryRun
    ? dryRun(config)
    : mode === "stage"
      ? await stage(config)
      : await readback(config);
  console.log(JSON.stringify(evidence));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`iOS staging failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}

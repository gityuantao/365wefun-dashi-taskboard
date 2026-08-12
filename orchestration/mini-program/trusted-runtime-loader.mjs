import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TRUSTED_RUNTIMES = new WeakSet();
const MODULE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/u;
const PRODUCTION_TRUSTED_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(PRODUCTION_TRUSTED_ROOT, "../..");
const TEST_RUNTIME_HELPER = path.join(PROJECT_ROOT, "test", "fixtures", "trusted-mini-program-runtime", "runtime-loader.mjs");
const TEST_TRUSTED_ROOT = path.dirname(TEST_RUNTIME_HELPER);

function requiredName(value, field) {
  if (typeof value !== "string" || !MODULE_NAME.test(value) || path.basename(value) !== value) {
    throw new Error(`mini-program trusted ${field} must be a relative allowlisted module name`);
  }
  return value;
}

async function assertAbsolutePathHasNoSymlink(absolutePath, field) {
  const absolute = path.resolve(absolutePath);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`mini-program trusted ${field} must not contain symlinks`);
  }
  const canonical = await realpath(absolute);
  if (canonical !== absolute) throw new Error(`mini-program trusted ${field} must equal its canonical path`);
  return canonical;
}

export async function validateTrustedRuntimeModuleAtFixedRoot(trustedRoot, directory, moduleName) {
  const trustedName = requiredName(moduleName, directory);
  const canonicalRoot = await assertAbsolutePathHasNoSymlink(trustedRoot, "runtime root");
  const directoryPath = path.join(canonicalRoot, directory);
  const canonicalDirectory = await assertAbsolutePathHasNoSymlink(directoryPath, directory);
  if (path.dirname(canonicalDirectory) !== canonicalRoot) throw new Error("mini-program trusted module directory escaped its fixed root");
  const modulePath = path.join(canonicalDirectory, trustedName);
  const info = await lstat(modulePath);
  if (info.isSymbolicLink()) throw new Error("mini-program trusted module path must not contain symlinks");
  if (!info.isFile()) throw new Error("mini-program trusted module must be a regular file");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("mini-program trusted module must be owned by the current user");
  if ((info.mode & 0o022) !== 0) throw new Error("mini-program trusted module must not be group/world writable");
  const canonicalModule = await realpath(modulePath);
  if (canonicalModule !== modulePath || path.dirname(canonicalModule) !== canonicalDirectory) {
    throw new Error("mini-program trusted module must equal its fixed canonical path");
  }
  return canonicalModule;
}

function validProvider(value) {
  return value && typeof value.createSession === "function"
    && typeof value.readiness === "function"
    && typeof value.implementationId === "string" && typeof value.profileId === "string";
}

async function fixedRuntimeRoot(testAuthority) {
  if (testAuthority === undefined) return PRODUCTION_TRUSTED_ROOT;
  const helperPath = await assertAbsolutePathHasNoSymlink(TEST_RUNTIME_HELPER, "test runtime helper");
  const helperInfo = await lstat(helperPath);
  if (!helperInfo.isFile()
    || (typeof process.getuid === "function" && helperInfo.uid !== process.getuid())
    || (helperInfo.mode & 0o022) !== 0) {
    throw new Error("mini-program test runtime helper must be an owned non-writable regular file");
  }
  const helper = await import(pathToFileURL(helperPath).href);
  if (typeof helper.isTrustedMiniProgramTestAuthority !== "function"
    || helper.isTrustedMiniProgramTestAuthority(testAuthority) !== true) {
    throw new Error("mini-program test runtime authority is invalid");
  }
  return TEST_TRUSTED_ROOT;
}

export async function createTrustedMiniProgramRuntimeLoader({
  sandboxProviderModule,
  stageRunnerModule,
  testAuthority,
} = {}) {
  const trustedRoot = await fixedRuntimeRoot(testAuthority);
  const sandboxPath = await validateTrustedRuntimeModuleAtFixedRoot(trustedRoot, "sandbox-providers", sandboxProviderModule);
  const stageRunnerPath = await validateTrustedRuntimeModuleAtFixedRoot(trustedRoot, "stage-runners", stageRunnerModule);
  const sandboxNamespace = await import(pathToFileURL(sandboxPath).href);
  const stageNamespace = await import(pathToFileURL(stageRunnerPath).href);
  const provider = sandboxNamespace.default ?? sandboxNamespace.sandboxProvider;
  const stageRunner = stageNamespace.default ?? stageNamespace.stageRunner;
  if (!validProvider(provider)) throw new Error("mini-program trusted sandbox provider contract is invalid");
  const readiness = await provider.readiness();
  if (!readiness || readiness.available !== true) {
    throw new Error(`mini-program trusted sandbox provider is unavailable: ${readiness?.reason ?? "readiness check failed"}`);
  }
  if (typeof stageRunner !== "function") throw new Error("mini-program trusted stage runner contract is invalid");
  const runtime = Object.freeze({ provider, stageRunner });
  TRUSTED_RUNTIMES.add(runtime);
  return runtime;
}

export function requireTrustedMiniProgramRuntime(runtime) {
  if (!TRUSTED_RUNTIMES.has(runtime)) throw new Error("mini-program execution requires a loader-authorized trusted runtime");
  return runtime;
}

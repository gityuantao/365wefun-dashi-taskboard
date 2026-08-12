import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TRUSTED_RUNTIMES = new WeakSet();
const MODULE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/u;

function requiredName(value, field) {
  if (typeof value !== "string" || !MODULE_NAME.test(value) || path.basename(value) !== value) {
    throw new Error(`mini-program trusted ${field} must be a relative allowlisted module name`);
  }
  return value;
}

async function trustedModulePath(trustedRoot, directory, moduleName) {
  const trustedName = requiredName(moduleName, directory);
  const canonicalProject = await realpath(trustedRoot);
  const relative = path.join(directory, trustedName);
  let current = canonicalProject;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("mini-program trusted module path must not contain symlinks");
  }
  const info = await lstat(current);
  if (!info.isFile()) throw new Error("mini-program trusted module must be a regular file");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("mini-program trusted module must be owned by the current user");
  if ((info.mode & 0o022) !== 0) throw new Error("mini-program trusted module must not be group/world writable");
  const canonical = await realpath(current);
  const expectedRoot = path.join(canonicalProject, directory);
  if (path.dirname(canonical) !== expectedRoot) throw new Error("mini-program trusted module escaped its fixed allowlisted directory");
  return canonical;
}

function validProvider(value) {
  return value && typeof value.createSession === "function"
    && typeof value.implementationId === "string" && typeof value.profileId === "string";
}

export async function createTrustedMiniProgramRuntimeLoader({
  projectRoot,
  sandboxProviderModule,
  stageRunnerModule,
  importModule = (filePath) => import(pathToFileURL(filePath).href),
}) {
  const trustedRoot = path.join(await realpath(projectRoot), "orchestration", "mini-program");
  const sandboxPath = await trustedModulePath(trustedRoot, "sandbox-providers", sandboxProviderModule);
  const stageRunnerPath = await trustedModulePath(trustedRoot, "stage-runners", stageRunnerModule);
  const sandboxNamespace = await importModule(sandboxPath);
  const stageNamespace = await importModule(stageRunnerPath);
  const provider = sandboxNamespace.default ?? sandboxNamespace.sandboxProvider;
  const stageRunner = stageNamespace.default ?? stageNamespace.stageRunner;
  if (!validProvider(provider)) throw new Error("mini-program trusted sandbox provider contract is invalid");
  if (typeof stageRunner !== "function") throw new Error("mini-program trusted stage runner contract is invalid");
  const runtime = Object.freeze({ provider, stageRunner });
  TRUSTED_RUNTIMES.add(runtime);
  return runtime;
}

export async function createTrustedMiniProgramTestRuntime({
  projectRoot,
  provider,
  stageRunner = async () => ({}),
  sandboxProviderModule = "fake.mjs",
  stageRunnerModule = "fake.mjs",
}) {
  const trustedRoot = path.join(await realpath(projectRoot), "test", "fixtures", "trusted-mini-program-runtime");
  const sandboxPath = await trustedModulePath(trustedRoot, "sandbox-providers", sandboxProviderModule);
  const stageRunnerPath = await trustedModulePath(trustedRoot, "stage-runners", stageRunnerModule);
  const runtime = Object.freeze({ provider, stageRunner, sandboxPath, stageRunnerPath });
  if (!validProvider(provider) || typeof stageRunner !== "function") throw new Error("mini-program test trusted runtime contract is invalid");
  TRUSTED_RUNTIMES.add(runtime);
  return runtime;
}

export function requireTrustedMiniProgramRuntime(runtime) {
  if (!TRUSTED_RUNTIMES.has(runtime)) throw new Error("mini-program execution requires a loader-authorized trusted runtime");
  return runtime;
}

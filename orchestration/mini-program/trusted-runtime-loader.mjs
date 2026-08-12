import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TRUSTED_RUNTIMES = new WeakSet();
const TRUSTED_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_NAME = "darwin-sandbox-exec.mjs";
const RUNNER_NAME = "wechat-command.mjs";

async function assertTrustedDirectory(directoryPath, field) {
  const absolute = path.resolve(directoryPath);
  let current = path.parse(absolute).root;
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`mini-program trusted ${field} path components must be real directories`);
    if (currentUid !== null && info.uid !== 0 && info.uid !== currentUid) throw new Error(`mini-program trusted ${field} path components must be owned by root or the current user`);
    if ((info.mode & 0o022) !== 0) throw new Error(`mini-program trusted ${field} path components must not be group/world writable`);
  }
  if (await realpath(absolute) !== absolute) throw new Error(`mini-program trusted ${field} must equal its canonical path`);
  return absolute;
}

export async function validateTrustedRuntimeModuleAtFixedRoot(trustedRoot, directory, moduleName) {
  const canonicalRoot = await assertTrustedDirectory(trustedRoot, "runtime root");
  const canonicalDirectory = await assertTrustedDirectory(path.join(canonicalRoot, directory), directory);
  if (path.dirname(canonicalDirectory) !== canonicalRoot) throw new Error("mini-program trusted module directory escaped its fixed root");
  const modulePath = path.join(canonicalDirectory, moduleName);
  if (path.basename(modulePath) !== moduleName || !moduleName.endsWith(".mjs")) throw new Error("mini-program trusted module name is invalid");
  const handle = await open(modulePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("mini-program trusted module must be a regular file");
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) throw new Error("mini-program trusted module must be owned by the current user");
    if ((before.mode & 0o022) !== 0) throw new Error("mini-program trusted module must not be group/world writable");
    const source = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(modulePath);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || after.dev !== current.dev || after.ino !== current.ino || current.isSymbolicLink()) {
      throw new Error("mini-program trusted module changed during verified import");
    }
    return Object.freeze({
      modulePath,
      source,
      digest: createHash("sha256").update(source).digest("hex"),
    });
  } finally { await handle.close(); }
}

async function importVerifiedModule(directory, moduleName) {
  const verified = await validateTrustedRuntimeModuleAtFixedRoot(TRUSTED_ROOT, directory, moduleName);
  const sourceUrl = `data:text/javascript;base64,${verified.source.toString("base64")}#sha256-${verified.digest}`;
  return import(sourceUrl);
}

function validProvider(value) {
  return value && typeof value.createSession === "function" && typeof value.readiness === "function"
    && typeof value.implementationId === "string" && typeof value.profileId === "string";
}

export async function createTrustedMiniProgramRuntimeLoader() {
  const [sandboxNamespace, stageNamespace] = await Promise.all([
    importVerifiedModule("sandbox-providers", PROVIDER_NAME),
    importVerifiedModule("stage-runners", RUNNER_NAME),
  ]);
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

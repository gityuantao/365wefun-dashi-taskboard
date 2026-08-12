import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MAX_EXPORT_FILES = 20_000;
const MAX_EXPORT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const GROUP_DRAIN_TIMEOUT_MS = 2_000;
const FIXED_RUNTIME_FILES = Object.freeze([
  "/bin/sh", "/bin/bash", "/bin/cat", "/usr/bin/true", "/bin/sleep", "/usr/bin/curl",
  "/usr/bin/env", "/usr/bin/dirname",
]);
const FIXED_RUNTIME_ROOTS = Object.freeze(["/System", "/usr/lib", "/usr/share", "/Library/Apple", "/private/etc", "/dev"]);
const PNPM_CANDIDATES = Object.freeze(["/usr/local/bin/pnpm", "/opt/homebrew/bin/pnpm"]);

function escapeProfilePath(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function uniqueRoots(values) {
  return [...new Set(values.map((value) => path.resolve(value)))];
}

async function canonicalRoots(values, field) {
  const roots = [];
  for (const value of uniqueRoots(values ?? [])) {
    const canonical = await realpath(value);
    if (canonical !== value) throw new Error(`Darwin sandbox ${field} must be canonical`);
    roots.push(canonical);
  }
  return roots;
}

async function sandboxProfile(request) {
  const readOnlyRoots = await canonicalRoots(request.filesystem.readOnlyRoots, "readOnlyRoots");
  const writableRoots = await canonicalRoots(request.filesystem.writableRoots, "writableRoots");
  const deniedRoots = await canonicalRoots(request.filesystem.deniedRoots, "deniedRoots");
  if (request.network?.mode !== "deny-all" || request.network.profileId !== darwinSandboxProvider.profileId) {
    throw new Error("Darwin sandbox requires the fixed deny-all network profile");
  }
  if (request.implementationId !== darwinSandboxProvider.implementationId
    || request.processGroup?.detached !== true
    || request.processGroup?.terminateOnFailure !== true
    || request.processGroup?.awaitExit !== true) {
    throw new Error("Darwin sandbox lifecycle contract is invalid");
  }
  const runtimeReadRoots = [];
  for (const candidate of FIXED_RUNTIME_ROOTS) {
    if (!candidate) continue;
    try { runtimeReadRoots.push(await realpath(candidate)); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const dependencyRoots = [];
  const packagedDependencies = path.resolve(path.dirname(process.execPath), "../..");
  const packagedPnpm = path.join(packagedDependencies, "bin/fallback/pnpm");
  if (request.file === await realpath(packagedPnpm).catch(() => null)) {
    for (const candidate of [path.join(packagedDependencies, "node/node_modules/pnpm"), path.dirname(process.execPath)]) {
      dependencyRoots.push(await realpath(candidate));
    }
  }
  const readableRoots = uniqueRoots([...readOnlyRoots, ...writableRoots, ...runtimeReadRoots, ...dependencyRoots]);
  const runtimeFiles = [];
  for (const candidate of FIXED_RUNTIME_FILES) {
    try { runtimeFiles.push(await realpath(candidate)); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  runtimeFiles.push(await realpath(request.file));
  const rules = [
    "(version 1)",
    "(deny default)",
    "(import \"system.sb\")",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    ...uniqueRoots(runtimeFiles).map((file) => `(allow file-read* (literal "${escapeProfilePath(file)}"))`),
    ...readableRoots.map((root) => `(allow file-read* (literal \"${escapeProfilePath(root)}\") (subpath \"${escapeProfilePath(root)}\"))`),
    ...writableRoots.map((root) => `(allow file-write* (subpath \"${escapeProfilePath(root)}\"))`),
    ...deniedRoots.map((root) => `(deny file-read* file-write* (subpath \"${escapeProfilePath(root)}\"))`),
  ];
  return rules.join(" ");
}

async function protectReadOnlyRoots(request, permissions) {
  const readOnlyRoots = await canonicalRoots(request.filesystem.readOnlyRoots, "readOnlyRoots");
  const canonicalCwd = await realpath(request.cwd);
  if (!readOnlyRoots.includes(canonicalCwd)) throw new Error("Darwin sandbox cwd must be a declared read-only root");
  async function protect(root) {
    const info = await lstat(root);
    if (info.isSymbolicLink()) throw new Error("Darwin sandbox read-only root contains a symlink");
    if (info.isDirectory()) {
      for (const entry of await readdir(root)) await protect(path.join(root, entry));
    } else if (!info.isFile()) throw new Error("Darwin sandbox read-only root contains a non-regular entry");
    permissions.push({ filePath: root, mode: info.mode & 0o777 });
    await chmod(root, (info.mode & 0o777) & ~0o222);
  }
  for (const root of readOnlyRoots) await protect(root);
}

async function restorePermissions(permissions) {
  const failures = [];
  for (const { filePath, mode } of permissions.toReversed()) {
    try { await chmod(filePath, mode); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Darwin sandbox permission restoration failed");
}

async function canonicalPrivateRoot(value, field) {
  const canonical = await realpath(path.resolve(value));
  const info = await lstat(canonical);
  if (!info.isDirectory() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o777) !== 0o700) {
    throw new Error(`Darwin sandbox ${field} must be a private owned 0700 directory`);
  }
  return canonical;
}

async function readFiles(root, relative = "", result = [], totals = { bytes: 0 }) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("Darwin sandbox exported artifact contains a symlink");
    if (entry.isDirectory()) await readFiles(root, child, result, totals);
    else if (entry.isFile()) {
      if (result.length >= MAX_EXPORT_FILES) throw new Error("Darwin sandbox export exceeded the file-count limit");
      const handle = await open(path.join(root, ...child.split("/")), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("Darwin sandbox exported artifact changed during read");
        if (info.size > MAX_EXPORT_FILE_BYTES) throw new Error("Darwin sandbox export exceeded the per-file limit");
        const chunks = [];
        let fileBytes = 0;
        while (true) {
          const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          fileBytes += bytesRead;
          totals.bytes += bytesRead;
          if (fileBytes > MAX_EXPORT_FILE_BYTES) throw new Error("Darwin sandbox export exceeded the per-file limit while reading");
          if (totals.bytes > MAX_EXPORT_BYTES) throw new Error("Darwin sandbox export exceeded the total-size limit while reading");
          chunks.push(buffer.subarray(0, bytesRead));
        }
        const after = await handle.stat();
        if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || fileBytes !== info.size) {
          throw new Error("Darwin sandbox exported artifact changed during read");
        }
        result.push({ relative: child, content: Buffer.concat(chunks, fileBytes) });
      } finally { await handle.close(); }
    } else throw new Error("Darwin sandbox exported artifact contains a non-regular entry");
  }
  return result;
}

async function copyExport(sourceRoot, targetRoot, relative = "", totals = { files: 0, bytes: 0 }) {
  for (const entry of await readdir(path.join(sourceRoot, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Darwin sandbox Candidate output contains a symlink");
    if (entry.isDirectory()) {
      await mkdir(path.join(targetRoot, child), { mode: 0o700 });
      await copyExport(sourceRoot, targetRoot, child, totals);
    } else if (entry.isFile()) {
      const input = await open(path.join(sourceRoot, child), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const info = await input.stat();
        if (!info.isFile()) throw new Error("Darwin sandbox Candidate output changed during export");
        totals.files += 1;
        if (totals.files > MAX_EXPORT_FILES) throw new Error("Darwin sandbox export exceeded the file-count limit");
        if (info.size > MAX_EXPORT_FILE_BYTES) throw new Error("Darwin sandbox export exceeded the per-file limit");
        const output = await open(path.join(targetRoot, child), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        let fileBytes = 0;
        try {
          while (true) {
            const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
            const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            fileBytes += bytesRead;
            totals.bytes += bytesRead;
            if (fileBytes > MAX_EXPORT_FILE_BYTES) throw new Error("Darwin sandbox export exceeded the per-file limit while copying");
            if (totals.bytes > MAX_EXPORT_BYTES) throw new Error("Darwin sandbox export exceeded the total-size limit while copying");
            await output.write(buffer, 0, bytesRead, null);
          }
        } finally { await output.close(); }
        const after = await input.stat();
        if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || fileBytes !== info.size) {
          throw new Error("Darwin sandbox Candidate output changed during export");
        }
      } finally { await input.close(); }
    } else throw new Error("Darwin sandbox Candidate output contains a non-regular entry");
  }
}

async function makeReadOnly(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) await makeReadOnly(child);
    await chmod(child, entry.isDirectory() ? 0o550 : 0o440);
  }
  await chmod(root, 0o550);
}

function digestEntries(entries) {
  const hash = createHash("sha256");
  let artifactSize = 0;
  for (const { relative, content } of entries) {
    artifactSize += content.length;
    hash.update(Buffer.from(`${relative}\0${content.length}\0`));
    hash.update(content);
  }
  return { artifactSize, artifactDigest: `sha256:${hash.digest("hex")}` };
}

function completionFor(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (!Number.isSafeInteger(code)) reject(new Error(`Darwin sandbox process ended by ${signal ?? "unknown signal"}`));
      else resolve({ exitCode: code });
    });
  });
}

async function resolveExecutable(file) {
  if (file === "pnpm") {
    const packaged = path.resolve(path.dirname(process.execPath), "../../bin/fallback/pnpm");
    for (const candidate of [...PNPM_CANDIDATES, packaged]) {
      try { await access(candidate, fsConstants.X_OK); return realpath(candidate); } catch {}
    }
    throw new Error("Darwin sandbox reviewed pnpm runtime is unavailable");
  }
  const canonical = await realpath(file);
  const allowed = await Promise.all(FIXED_RUNTIME_FILES.map((candidate) => realpath(candidate).catch(() => null)));
  if (!allowed.includes(canonical)) throw new Error("Darwin sandbox executable is outside the fixed runtime allowlist");
  return canonical;
}

function groupExists(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function waitGroupEmpty(pgid) {
  const deadline = Date.now() + GROUP_DRAIN_TIMEOUT_MS;
  while (groupExists(pgid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

const darwinSandboxProvider = Object.freeze({
  implementationId: "darwin-sandbox-exec-v1",
  profileId: "darwin-sandbox-exec-deny-all-v1",
  deniedRoots: [],
  async readiness() {
    if (process.platform !== "darwin") return { available: false, platform: process.platform, reason: "Darwin sandbox-exec is unavailable on this platform" };
    try {
      await access(SANDBOX_EXEC, fsConstants.X_OK);
      return { available: true, platform: "darwin" };
    } catch {
      return { available: false, platform: "darwin", reason: "sandbox-exec is not executable" };
    }
  },
  createSession(request) {
    let child;
    let completion;
    let mountedOutput;
    let protectedPermissions = [];
    let restored = false;
    let abortListener;
    const restore = async () => {
      if (restored) return;
      const failures = [];
      try { await restorePermissions(protectedPermissions); } catch (error) { failures.push(error); }
      if (mountedOutput) try {
          const parent = path.dirname(mountedOutput.sourcePath);
          const info = await lstat(parent);
          if (!info.isDirectory()) throw new Error("Darwin sandbox mount parent cleanup failed");
          await chmod(parent, (info.mode & 0o777) | 0o200);
          try { await rm(mountedOutput.sourcePath, { force: true }); }
          finally { await chmod(parent, info.mode & 0o777); }
        } catch (error) { failures.push(error); }
      if (failures.length > 0) throw new AggregateError(failures, "Darwin sandbox cleanup restoration failed");
      restored = true;
    };
    return Object.freeze({
      async start() {
        const readiness = await darwinSandboxProvider.readiness();
        if (!readiness.available) throw new Error(`Darwin sandbox unavailable: ${readiness.reason}`);
        try {
          await protectReadOnlyRoots(request, protectedPermissions);
          const mounts = request.filesystem.mounts ?? [];
          if (mounts.length > 1 || mounts.some((mount) => mount.mode !== "candidate-output")) throw new Error("Darwin sandbox accepts only one Candidate output mount");
          if (mounts.length === 1) {
            const mount = mounts[0];
            const canonicalTarget = await canonicalPrivateRoot(mount.targetPath, "Candidate output target");
            const canonicalCwd = await realpath(request.cwd);
            const sourcePath = path.resolve(mount.sourcePath);
            const relativeSource = path.relative(canonicalCwd, sourcePath);
            if (!relativeSource || relativeSource === ".." || relativeSource.startsWith(`..${path.sep}`) || path.isAbsolute(relativeSource)) {
              throw new Error("Darwin sandbox Candidate output mount must be beneath cwd");
            }
            const sourceParent = path.dirname(sourcePath);
            const parentInfo = await lstat(sourceParent);
            if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error("Darwin sandbox Candidate output mount parent must be a directory");
            const originalParentMode = parentInfo.mode & 0o777;
            if ((originalParentMode & 0o200) === 0) await chmod(sourceParent, originalParentMode | 0o200);
            const sourceInfo = await lstat(sourcePath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
            if (sourceInfo) throw new Error("Darwin sandbox Candidate output mount path must not pre-exist");
            try {
              await symlink(canonicalTarget, sourcePath);
              mountedOutput = { sourcePath, targetPath: canonicalTarget };
            } finally { if ((originalParentMode & 0o200) === 0) await chmod(sourceParent, originalParentMode); }
          }
          const executable = await resolveExecutable(request.file);
          const profile = await sandboxProfile({ ...request, file: executable });
          child = spawn(SANDBOX_EXEC, ["-p", profile, executable, ...request.args], {
            cwd: request.cwd,
            env: Object.freeze({ ...request.env, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }),
            detached: true,
            stdio: ["ignore", "ignore", "ignore"],
          });
          abortListener = () => {
            try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
          };
          if (request.signal?.aborted) abortListener();
          else request.signal?.addEventListener("abort", abortListener, { once: true });
          completion = completionFor(child);
          return completion;
        } catch (error) {
          await restore();
          throw error;
        }
      },
      async terminate() {
        if (!child?.pid) return;
        try { process.kill(-child.pid, "SIGKILL"); } catch {
          try { child.kill("SIGKILL"); } catch {}
        }
        await completion?.catch(() => {});
        if (!await waitGroupEmpty(child.pid)) throw new Error("Darwin sandbox process group did not drain");
        request.signal?.removeEventListener("abort", abortListener);
        await restore();
      },
      async wait() {
        if (!completion) throw new Error("Darwin sandbox session has not started");
        let result;
        let completionError;
        try { result = await completion; } catch (error) { completionError = error; }
        if (!await waitGroupEmpty(child.pid)) throw new Error("Darwin sandbox process group is not quiescent");
        request.signal?.removeEventListener("abort", abortListener);
        await restore();
        if (completionError) throw completionError;
        return result;
      },
      async exportArtifact({ ownedArtifactRoot }) {
        if (!mountedOutput) throw new Error("Darwin sandbox session has no Candidate output mount");
        const ownedRoot = await canonicalPrivateRoot(ownedArtifactRoot, "owned artifact root");
        const temporary = await mkdtemp(path.join(ownedRoot, ".darwin-export-"));
        const artifactPath = path.join(temporary, "artifact");
        await mkdir(artifactPath, { mode: 0o700 });
        try {
          await copyExport(mountedOutput.targetPath, artifactPath);
          const entries = await readFiles(artifactPath);
          const evidence = digestEntries(entries);
          const captured = Object.freeze(entries.map(({ relative, content }) => Object.freeze({ relative, content: Buffer.from(content) })));
          await makeReadOnly(artifactPath);
          return Object.freeze({ artifactPath, ...evidence, readFiles: async () => captured.map(({ relative, content }) => ({ relative, content: Buffer.from(content) })) });
        } catch (error) {
          await rm(temporary, { recursive: true, force: true });
          throw error;
        }
      },
    });
  },
});

export default darwinSandboxProvider;

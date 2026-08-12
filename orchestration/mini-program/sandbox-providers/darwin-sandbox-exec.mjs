import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

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
  for (const candidate of ["/System", "/usr", "/bin", "/sbin", "/Library/Apple", "/private/etc", "/dev", ...String(request.env?.PATH ?? "").split(path.delimiter)]) {
    if (!candidate) continue;
    try { runtimeReadRoots.push(await realpath(candidate)); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const readableRoots = uniqueRoots([...readOnlyRoots, ...writableRoots, ...runtimeReadRoots]);
  const rules = [
    "(version 1)",
    "(deny default)",
    "(import \"system.sb\")",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
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
  for (const { filePath, mode } of permissions.toReversed()) await chmod(filePath, mode).catch(() => {});
}

async function canonicalPrivateRoot(value, field) {
  const canonical = await realpath(path.resolve(value));
  const info = await lstat(canonical);
  if (!info.isDirectory() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o777) !== 0o700) {
    throw new Error(`Darwin sandbox ${field} must be a private owned 0700 directory`);
  }
  return canonical;
}

async function readFiles(root, relative = "") {
  const result = [];
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("Darwin sandbox exported artifact contains a symlink");
    if (entry.isDirectory()) result.push(...await readFiles(root, child));
    else if (entry.isFile()) {
      const handle = await open(path.join(root, ...child.split("/")), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("Darwin sandbox exported artifact changed during read");
        result.push({ relative: child, content: await handle.readFile() });
      } finally { await handle.close(); }
    } else throw new Error("Darwin sandbox exported artifact contains a non-regular entry");
  }
  return result;
}

async function copyExport(sourceRoot, targetRoot, relative = "") {
  for (const entry of await readdir(path.join(sourceRoot, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Darwin sandbox Candidate output contains a symlink");
    if (entry.isDirectory()) {
      await mkdir(path.join(targetRoot, child), { mode: 0o700 });
      await copyExport(sourceRoot, targetRoot, child);
    } else if (entry.isFile()) {
      const input = await open(path.join(sourceRoot, child), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const info = await input.stat();
        if (!info.isFile()) throw new Error("Darwin sandbox Candidate output changed during export");
        const output = await open(path.join(targetRoot, child), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        try { await output.writeFile(await input.readFile()); } finally { await output.close(); }
      } finally { await input.close(); }
    } else throw new Error("Darwin sandbox Candidate output contains a non-regular entry");
  }
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
    const restore = async () => {
      if (restored) return;
      restored = true;
      await restorePermissions(protectedPermissions);
      if (mountedOutput) {
        const parent = path.dirname(mountedOutput.sourcePath);
        const info = await lstat(parent).catch(() => null);
        if (info?.isDirectory()) await chmod(parent, (info.mode & 0o777) | 0o200).catch(() => {});
        await rm(mountedOutput.sourcePath, { force: true }).catch(() => {});
        if (info?.isDirectory()) await chmod(parent, info.mode & 0o777).catch(() => {});
      }
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
            try { await symlink(canonicalTarget, sourcePath); }
            finally { if ((originalParentMode & 0o200) === 0) await chmod(sourceParent, originalParentMode); }
            mountedOutput = { sourcePath, targetPath: canonicalTarget };
          }
          const profile = await sandboxProfile(request);
          child = spawn(SANDBOX_EXEC, ["-p", profile, request.file, ...request.args], {
            cwd: request.cwd,
            env: request.env,
            detached: true,
            stdio: ["ignore", "ignore", "ignore"],
          });
          completion = completionFor(child).finally(restore);
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
      },
      async wait() {
        if (!completion) throw new Error("Darwin sandbox session has not started");
        await completion;
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
          return Object.freeze({ artifactPath, ...evidence, readFiles: () => readFiles(artifactPath) });
        } catch (error) {
          await rm(temporary, { recursive: true, force: true });
          throw error;
        }
      },
    });
  },
});

export default darwinSandboxProvider;

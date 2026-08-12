import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, open, readdir } from "node:fs/promises";
import path from "node:path";

async function copyTreeNoFollow(source, target, relative = "") {
  const entries = await readdir(path.join(source, relative), { withFileTypes: true });
  if (relative) await mkdir(path.join(target, relative), { mode: 0o700 });
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error("trusted test provider rejects artifact symlinks");
    if (entry.isDirectory()) { await copyTreeNoFollow(source, target, child); continue; }
    if (!entry.isFile()) throw new Error("trusted test provider rejects non-regular artifact entries");
    const input = await open(path.join(source, child), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const info = await input.stat();
      if (!info.isFile()) throw new Error("trusted test provider source changed during export");
      const output = await open(path.join(target, child), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      try { await output.writeFile(await input.readFile()); } finally { await output.close(); }
    } finally { await input.close(); }
  }
}

async function readTreeNoFollow(root, relative = "") {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error("trusted test provider rejects exported symlinks");
    if (entry.isDirectory()) { result.push(...await readTreeNoFollow(root, child)); continue; }
    const handle = await open(path.join(root, child), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("trusted test provider export changed");
      result.push({ relative: child, content: await handle.readFile() });
    } finally { await handle.close(); }
  }
  return result.sort((left, right) => left.relative.localeCompare(right.relative));
}

export async function exportOwnedArtifact({ sourceRoot, ownedArtifactRoot }) {
  const exportedRoot = await mkdtemp(path.join(ownedArtifactRoot, ".trusted-provider-export-"));
  const artifactPath = path.join(exportedRoot, "artifact");
  await mkdir(artifactPath, { mode: 0o700 });
  await copyTreeNoFollow(sourceRoot, artifactPath);
  return Object.freeze({ artifactPath, readFiles: () => readTreeNoFollow(artifactPath) });
}

export default Object.freeze({
  implementationId: "spawned-test-provider-v1",
  profileId: "spawned-deny-all-v1",
  deniedRoots: [],
  createSession(request) {
    const outputRoot = request.filesystem.mounts[0].targetPath;
    return {
      async start() {
        if (request.args.includes("build")) {
          await mkdir(outputRoot, { recursive: true, mode: 0o700 });
          const descriptor = await open(path.join(outputRoot, "project.config.json"), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
          try { await descriptor.writeFile(JSON.stringify({ appid: "wx1fdac5e27c6b5366" })); } finally { await descriptor.close(); }
          const source = await open(path.join(outputRoot, "app.js"), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
          try { await source.writeFile("const api='https://api.365life.example/v1';\n"); } finally { await source.close(); }
        }
        return { exitCode: 0 };
      },
      async terminate() {},
      async wait() {},
      exportArtifact: ({ ownedArtifactRoot }) => exportOwnedArtifact({ sourceRoot: outputRoot, ownedArtifactRoot }),
    };
  },
});

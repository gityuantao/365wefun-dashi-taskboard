#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  stagingProbeUrls,
  stagingReleaseRootMode,
  stagingRsyncArgs,
} from "../orchestration/release/staging-deployment-layout.mjs";

const runFile = promisify(execFile);
const host = process.env.STAGING_SSH_HOST ?? "root@47.103.25.142";
const repoPath = process.env.STAGING_REPO_PATH;
const candidateCommit = String(process.env.STAGING_CANDIDATE_COMMIT ?? "").trim();
const versionBranch = String(process.env.STAGING_VERSION_BRANCH ?? "").trim();
const taskId = String(process.env.STAGING_TASK_ID ?? "").trim();
const targetVersion = String(process.env.STAGING_TARGET_VERSION ?? "").trim();
const base = "/opt/e365-staging";
const publicUrl = "https://test-api.365english.online";

if (!repoPath || !/^[0-9a-f]{40}$/i.test(candidateCommit)) {
  throw new Error("staging deploy requires a repository path and a full candidate SHA");
}

async function run(file, args, options = {}) {
  return runFile(file, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, ...options });
}

async function ssh(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, "bash", "-seu", "--", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`staging SSH command failed (${code}): ${stderr.trim()}`));
    });
    child.stdin.end(script);
  });
}

const worktree = await mkdtemp(path.join(tmpdir(), "e365-staging-candidate-"));
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const releaseId = `${stamp}-${candidateCommit.slice(0, 8)}`;
const releasePath = `${base}/releases/${releaseId}`;
let previousRelease = null;
let previousReleaseId = "local";
let previousGitSha = "local";
let switched = false;

try {
  try {
    const previousVersion = JSON.parse((await run("curl", ["--fail", "--silent", "--show-error", "--max-time", "20", `${publicUrl}/version`])).stdout);
    previousReleaseId = String(previousVersion.releaseId ?? "local");
    previousGitSha = String(previousVersion.gitSha ?? "local");
  } catch {}
  await run("git", ["-C", repoPath, "worktree", "add", "--detach", worktree, candidateCommit]);
  await run("pnpm", ["install", "--frozen-lockfile"], { cwd: worktree, timeout: 10 * 60_000 });
  await run("pnpm", ["--filter", "@e365/db", "exec", "prisma", "generate"], {
    cwd: worktree,
    timeout: 5 * 60_000,
  });
  await run("pnpm", ["build"], { cwd: worktree, timeout: 15 * 60_000 });

  const prepared = await ssh(`
previous="$(readlink -f "${base}/current")"
mkdir -p "$1"
if [ -d "$previous/node_modules" ]; then cp -al "$previous/node_modules" "$1/node_modules"; fi
for scope in apps packages; do
  if [ -d "$previous/$scope" ]; then
    find "$previous/$scope" -mindepth 2 -maxdepth 2 -type d -name node_modules -print0 | while IFS= read -r -d '' source; do
      relative="\${source#"$previous/"}"
      mkdir -p "$1/$(dirname "$relative")"
      cp -al "$source" "$1/$relative"
    done
  fi
done
printf '%s' "$previous"
`, [releasePath]);
  previousRelease = prepared.stdout.trim();

  await run("rsync", stagingRsyncArgs({ worktree, host, releasePath }), { timeout: 10 * 60_000 });

  await ssh(`
release="$1"
chmod "$4" "$release"
ln -s "${base}/shared/.env" "$release/.env"
export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH
cd "$release"
node node_modules/.pnpm/prisma@6.19.3_typescript@5.9.3/node_modules/prisma/build/index.js generate --schema packages/db/prisma
node node_modules/.pnpm/prisma@6.19.3_typescript@5.9.3/node_modules/prisma/build/index.js db push --skip-generate --schema packages/db/prisma
ln -sfn "$release" "${base}/current"
export RELEASE_ID="$2" GIT_SHA="$3"
pm2 restart e365-api e365-worker --update-env
`, [releasePath, releaseId, candidateCommit, stagingReleaseRootMode()]);
  switched = true;

  let version = null;
  let lastHealthError = null;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      for (const probeUrl of stagingProbeUrls()) {
        await run("curl", ["--fail", "--silent", "--show-error", "--max-time", "10", probeUrl]);
      }
      version = JSON.parse((await run("curl", ["--fail", "--silent", "--show-error", "--max-time", "10", `${publicUrl}/version`])).stdout);
      if (version.gitSha === candidateCommit && version.releaseId === releaseId) break;
      lastHealthError = new Error(`staging readback mismatch after restart: ${version.gitSha ?? "missing"}`);
    } catch (error) {
      lastHealthError = error;
    }
    version = null;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!version) throw lastHealthError ?? new Error("staging health did not become ready");
  console.log(JSON.stringify({ releaseId, url: publicUrl, startedAt: version.startedAt, candidateCommit, versionBranch, taskId, targetVersion }));
} catch (error) {
  if (switched && previousRelease) {
    try {
      await ssh(`
ln -sfn "$1" "${base}/current"
export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH
export RELEASE_ID="$2" GIT_SHA="$3"
pm2 restart e365-api e365-worker --update-env
`, [previousRelease, previousReleaseId, previousGitSha]);
    } catch {}
  }
  throw error;
} finally {
  try { await run("git", ["-C", repoPath, "worktree", "remove", "--force", worktree]); } catch {}
  await rm(worktree, { recursive: true, force: true });
}

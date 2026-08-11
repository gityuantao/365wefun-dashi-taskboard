import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

export function createProductionStagingAdapterFactory({
  runtime,
  projectRoot,
  importModule = (url) => import(url),
}) {
  return async () => {
    const modulePath = runtime.stagingAdapterModule
      ? path.resolve(projectRoot, runtime.stagingAdapterModule)
      : null;
    const module = modulePath ? await importModule(pathToFileURL(modulePath).href) : null;
    return typeof module?.createStagingAdapter === "function"
      ? module.createStagingAdapter({ runtime, projectRoot })
      : null;
  };
}

function requireSha(value, label) {
  const sha = String(value ?? "").trim();
  if (!/^[0-9a-f]{7,64}$/i.test(sha) || sha === "local") {
    throw new Error(`${label} did not return a deployable git SHA`);
  }
  return sha;
}

export function createStagingAdapter({ runtime, projectRoot }) {
  const command = runtime.stagingDeployCommand;
  const versionUrl = runtime.stagingVersionUrl;
  if (!Array.isArray(command) || command.length === 0 || typeof versionUrl !== "string") {
    return null;
  }
  return {
    async deploy({ candidateCommit, versionBranch, taskId, targetVersion }) {
      const [file, ...args] = command;
      const { stdout } = await execFileAsync(file, args, {
        encoding: "utf8",
        cwd: projectRoot,
        timeout: Number(runtime.stagingDeployTimeoutMs ?? 30 * 60_000),
        env: {
          ...process.env,
          STAGING_CANDIDATE_COMMIT: candidateCommit,
          STAGING_VERSION_BRANCH: versionBranch,
          STAGING_TASK_ID: taskId,
          STAGING_TARGET_VERSION: targetVersion,
          STAGING_REPO_PATH: runtime.repoPath,
        },
      });
      let result = {};
      try {
        result = JSON.parse(stdout.trim().split("\n").at(-1));
      } catch {
        throw new Error("staging deploy command did not return JSON evidence");
      }
      return {
        releaseId: String(result.releaseId ?? "").trim(),
        url: result.url ?? versionUrl,
        startedAt: result.startedAt ?? new Date().toISOString(),
      };
    },
    async readback({ deployment }) {
      const response = await fetch(versionUrl, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`staging version readback returned HTTP ${response.status}`);
      const body = await response.json();
      return {
        confirmed: true,
        releaseId: String(body.releaseId ?? deployment?.releaseId ?? "").trim(),
        gitSha: requireSha(body.gitSha, "staging version readback"),
        urls: [deployment?.url ?? versionUrl],
        deployedAt: body.startedAt ?? new Date().toISOString(),
      };
    },
  };
}

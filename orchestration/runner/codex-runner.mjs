import { spawn } from "node:child_process";
import { DomainError } from "../domain/errors.mjs";

const DEFAULT_TIMEOUT_MINUTES = 90;

export function runCodex({
  workdir,
  prompt,
  skillPath,
  timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
  codexBin = process.env.CODEX_BIN ?? "codex",
  spawnImpl = spawn,
}) {
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new DomainError("INVALID_PROMPT", "Codex prompt must be a non-empty string");
  }
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new DomainError("INVALID_TIMEOUT", "timeoutMinutes must be a positive number");
  }
  return new Promise((resolve, reject) => {
    const args = ["exec"];
    if (skillPath) args.push("--skill", skillPath);
    let child;
    try {
      child = spawnImpl(codexBin, args, {
        cwd: workdir,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new DomainError("SPAWN_FAILED", `Failed to spawn Codex: ${error.message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ exitCode: null, timedOut: true, stdout, stderr });
    }, timeoutMinutes * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut: false, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new DomainError("SPAWN_FAILED", `Failed to run Codex: ${error.message}`));
    });
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

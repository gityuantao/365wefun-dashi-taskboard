import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const MUTATIONS = new Set(["upload", "submitReview", "release"]);

function clean(value) {
  const text = String(value ?? "production WeChat command failed")
    .replace(/(?:Authorization|Cookie)\s*:[^\r\n]*/giu, "[REDACTED]")
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/giu, "https://[REDACTED]@")
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/giu, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return text.length > 256 ? "[REDACTED oversized output]" : text;
}

function failure(stage, message, code) {
  const error = new Error(clean(message));
  error.name = "WechatStageRunnerError";
  error.code = code;
  error.failureClassification = MUTATIONS.has(stage) ? "external_unknown" : "release_infrastructure";
  error.deterministic = false;
  return error;
}

function groupExists(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function terminateAndDrain(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  const deadline = Date.now() + 2_000;
  while (groupExists(child.pid)) {
    if (Date.now() >= deadline) throw new Error("production WeChat command process group did not drain");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runBoundedCommand(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (callback) => { if (!settled) { settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); callback(); } };
    const failAfterDrain = (error) => terminateAndDrain(child).then(() => finish(() => reject(error)), (drainError) => finish(() => reject(drainError)));
    const abort = () => failAfterDrain(new Error("production WeChat command aborted"));
    const timer = setTimeout(() => failAfterDrain(new Error("production WeChat command timed out")), COMMAND_TIMEOUT_MS);
    timer.unref?.();
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    const append = (current, chunk) => {
      const result = Buffer.concat([current, chunk]);
      if (result.length > MAX_OUTPUT_BYTES) failAfterDrain(new Error("production WeChat command output exceeded the bounded limit"));
      return result;
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => failAfterDrain(error));
    child.once("close", (code) => {
      const result = { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), exitCode: code };
      if (!groupExists(child.pid)) {
        finish(() => resolve(result));
        return;
      }
      terminateAndDrain(child).then(
        () => finish(() => reject(new Error("production WeChat command process group was not quiescent after leader exit"))),
        (error) => finish(() => reject(error)),
      );
    });
    child.stdin.end(options.input);
  });
}

function commandFor(config) {
  if (!Array.isArray(config?.frozenCommand) || config.frozenCommand.length === 0
    || JSON.stringify(config.frozenCommand) !== JSON.stringify(config.reviewedCommand)) {
    const error = new Error("production WeChat reviewed command does not match the frozen command");
    error.failureClassification = "validation";
    error.deterministic = true;
    throw error;
  }
  return config.frozenCommand;
}

export default async function runWechatCommandStage(config, { runCommand = runBoundedCommand } = {}) {
  const [file, ...args] = commandFor(config);
  const input = JSON.stringify({ ...config, signal: undefined, frozenCommand: undefined, reviewedCommand: undefined, reviewConfiguration: undefined });
  if (Buffer.byteLength(input) > MAX_OUTPUT_BYTES) throw failure(config.stage, "production WeChat command input exceeded the bounded limit", "COMMAND_INPUT_TOO_LARGE");
  let result;
  try {
    result = await runCommand(file, args, {
      cwd: undefined, env: Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }), input,
      signal: config.signal, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES,
    });
  } catch (error) { throw failure(config.stage, error?.message, error?.code ?? "COMMAND_SPAWN_FAILED"); }
  const exitCode = result?.exitCode ?? result?.code;
  if (!Number.isSafeInteger(exitCode) || exitCode !== 0) throw failure(config.stage, "production WeChat command completion requires an explicit zero exit code", "COMMAND_NONZERO");
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) throw failure(config.stage, "production WeChat command output exceeded the bounded limit", "COMMAND_OUTPUT_TOO_LARGE");
  const finalLine = stdout.trim().split(/\r?\n/u).at(-1);
  if (!finalLine) throw failure(config.stage, "production WeChat command returned no final JSON evidence", "FINAL_JSON_INVALID");
  let value;
  try { value = JSON.parse(finalLine); } catch { throw failure(config.stage, "production WeChat command returned invalid final JSON evidence", "FINAL_JSON_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure(config.stage, "production WeChat command returned invalid evidence", "FINAL_JSON_INVALID");
  return value;
}

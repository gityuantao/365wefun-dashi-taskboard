import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;

function runBoundedCommand(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const terminate = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
    };
    const timer = setTimeout(() => {
      terminate();
      if (!settled) { settled = true; reject(new Error("production WeChat command timed out")); }
    }, COMMAND_TIMEOUT_MS);
    timer.unref?.();
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const append = (current, chunk) => {
      const result = Buffer.concat([current, chunk]);
      if (result.length > MAX_OUTPUT_BYTES) {
        terminate();
        finish(() => reject(new Error("production WeChat command output exceeded the bounded limit")));
      }
      return result;
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      finish(() => resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), exitCode: code }));
    });
    child.stdin.end(options.input);
  });
}

function configuredCommand(config) {
  const command = config?.reviewConfiguration?.commands?.[config.stage];
  if (!Array.isArray(command) || command.length === 0
    || command.some((part) => typeof part !== "string" || part.trim() === "")) {
    throw new Error("production WeChat stage runner is not configured");
  }
  return command;
}

export default async function runWechatCommandStage(config, { runCommand = runBoundedCommand } = {}) {
  const [file, ...args] = configuredCommand(config);
  const input = JSON.stringify({ ...config, reviewConfiguration: { ...config.reviewConfiguration, commands: undefined } });
  if (Buffer.byteLength(input) > MAX_OUTPUT_BYTES) throw new Error("production WeChat command input exceeded the bounded limit");
  const result = await runCommand(file, args, {
    cwd: undefined,
    env: Object.freeze({ PATH: process.env.PATH ?? "", LANG: process.env.LANG ?? "C.UTF-8" }),
    input,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  const exitCode = result?.exitCode ?? result?.code;
  if (!Number.isSafeInteger(exitCode) || exitCode !== 0) throw new Error("production WeChat command completion requires an explicit zero exit code");
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) throw new Error("production WeChat command output exceeded the bounded limit");
  const finalLine = stdout.trim().split(/\r?\n/u).at(-1);
  if (!finalLine) throw new Error("production WeChat command returned no final JSON evidence");
  let value;
  try { value = JSON.parse(finalLine); } catch { throw new Error("production WeChat command returned invalid final JSON evidence"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("production WeChat command returned invalid evidence");
  return value;
}

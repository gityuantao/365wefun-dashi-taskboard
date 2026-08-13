import { spawn } from "node:child_process";
import path from "node:path";
import { DomainError } from "../domain/errors.mjs";

const DEFAULT_TIMEOUT_MINUTES = 90;
const DEFAULT_ABORT_GRACE_MS = 2_000;
const DEFAULT_ABORT_FORCE_CLOSE_MS = 1_000;
const DEFAULT_EXIT_CLOSE_GRACE_MS = 2_000;

const REQUIRED_ROLE_POLICIES = Object.freeze({
  analysis: Object.freeze({ model: "gpt-5.6-terra", reasoningEffort: "high" }),
  version_assignment: Object.freeze({ model: "gpt-5.6-terra", reasoningEffort: "medium" }),
  development: Object.freeze({ model: "gpt-5.6-sol", reasoningEffort: "xhigh" }),
  acceptance: Object.freeze({ model: "gpt-5.6-sol", reasoningEffort: "high" }),
});

function resolveRolePolicy(runtime, role) {
  const required = REQUIRED_ROLE_POLICIES[role];
  if (!required) {
    throw new DomainError(
      "INVALID_CODEX_ROLE",
      `Unsupported Codex role: ${String(role ?? "missing")}`,
    );
  }
  const configured = runtime?.codexRolePolicies?.[role];
  if (!configured || typeof configured !== "object") {
    throw new DomainError(
      "MISSING_CODEX_ROLE_POLICY",
      `Missing Codex role policy for ${role}`,
    );
  }
  if (
    configured.model !== required.model
    || configured.reasoningEffort !== required.reasoningEffort
  ) {
    throw new DomainError(
      "UNSUPPORTED_CODEX_ROLE_POLICY",
      `Unsupported Codex role policy for ${role}`,
      {
        role,
        requiredModel: required.model,
        requiredReasoningEffort: required.reasoningEffort,
      },
    );
  }
  return { role, ...required };
}

export function runCodex({
  workdir,
  prompt,
  skillPath,
  imagePaths = [],
  timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
  codexBin = process.env.CODEX_BIN ?? "codex",
  model,
  modelReasoningEffort,
  spawnImpl = spawn,
  signal,
  abortGraceMs = DEFAULT_ABORT_GRACE_MS,
  abortForceCloseMs = DEFAULT_ABORT_FORCE_CLOSE_MS,
  exitCloseGraceMs = DEFAULT_EXIT_CLOSE_GRACE_MS,
  killProcessGroup = (pid, signalName) => process.kill(-pid, signalName),
}) {
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new DomainError("INVALID_PROMPT", "Codex prompt must be a non-empty string");
  }
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new DomainError("INVALID_TIMEOUT", "timeoutMinutes must be a positive number");
  }
  if (!Number.isFinite(abortGraceMs) || abortGraceMs < 0
    || !Number.isFinite(abortForceCloseMs) || abortForceCloseMs < 0) {
    throw new DomainError(
      "INVALID_ABORT_TIMEOUT",
      "Codex abort grace and force-close timeouts must be non-negative numbers",
    );
  }
  if (!Array.isArray(imagePaths) || imagePaths.some((imagePath) => (
    typeof imagePath !== "string" || imagePath.trim() === "" || !path.isAbsolute(imagePath)
  ))) {
    throw new DomainError(
      "INVALID_IMAGE_PATH",
      "Codex image paths must be non-empty absolute paths",
    );
  }
  if (signal?.aborted) {
    return Promise.resolve({
      exitCode: null,
      timedOut: false,
      aborted: true,
      stdout: "",
      stderr: "",
    });
  }
  return new Promise((resolve, reject) => {
    const args = [
      "exec",
      "--model",
      model,
      "-c",
      `model_reasoning_effort=${JSON.stringify(modelReasoningEffort)}`,
    ];
    for (const imagePath of imagePaths) args.push("--image", imagePath);
    if (skillPath) args.push("--skill", skillPath);
    let child;
    try {
      child = spawnImpl(codexBin, args, {
        cwd: workdir,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      reject(new DomainError("SPAWN_FAILED", `Failed to spawn Codex: ${error.message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    let abortGraceTimer;
    let abortForceCloseTimer;
    let exitCloseTimer;
    let exitedCode;
    let terminationMode = null;
    let terminationError = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (abortGraceTimer) clearTimeout(abortGraceTimer);
      if (abortForceCloseTimer) clearTimeout(abortForceCloseTimer);
      if (exitCloseTimer) clearTimeout(exitCloseTimer);
      signal?.removeEventListener?.("abort", abort);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const requestTermination = (mode) => {
      if (settled || terminationMode) return;
      terminationMode = mode;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        killProcessGroup(child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      if (settled) return;
      abortGraceTimer = setTimeout(() => {
        try {
          killProcessGroup(child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        if (settled) return;
        abortForceCloseTimer = setTimeout(() => {
          fail(new DomainError(
            "TERMINATION_TIMEOUT",
            "Codex child did not close after SIGTERM and SIGKILL",
            { childError: terminationError?.message ?? null },
          ));
        }, abortForceCloseMs);
      }, abortGraceMs);
    };
    const abort = () => requestTermination("abort");
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    timer = setTimeout(() => {
      requestTermination("timeout");
    }, timeoutMinutes * 60_000);
    child.on("close", (code) => {
      finish({
        exitCode: code ?? exitedCode ?? null,
        timedOut: terminationMode === "timeout",
        aborted: terminationMode === "abort",
        stdout,
        stderr,
        ...(terminationError ? { terminationError: terminationError.message } : {}),
      });
    });
    child.on("exit", (code) => {
      exitedCode = code;
      exitCloseTimer = setTimeout(() => {
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        finish({
          exitCode: code,
          timedOut: terminationMode === "timeout",
          aborted: terminationMode === "abort",
          stdout,
          stderr,
          forcedPipeClose: true,
          ...(terminationError ? { terminationError: terminationError.message } : {}),
        });
      }, exitCloseGraceMs);
    });
    child.on("error", (error) => {
      if (terminationMode) {
        terminationError = error;
        return;
      }
      fail(new DomainError("SPAWN_FAILED", `Failed to run Codex: ${error.message}`));
    });
    signal?.addEventListener?.("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

export function createProductionCodexAdapter({ runtime, runCodexImpl = runCodex, spawnImpl } = {}) {
  return {
    run: async ({ role, prompt, workdir, taskId, signal, imagePaths }) => {
      const policy = resolveRolePolicy(runtime, role);
      const result = await runCodexImpl({
        workdir: workdir ?? runtime.repoPath,
        prompt,
        taskId,
        imagePaths,
        model: policy.model,
        modelReasoningEffort: policy.reasoningEffort,
        timeoutMinutes: runtime.codexTimeoutMinutes ?? 20,
        codexBin: runtime.codexBin ?? "codex",
        signal,
        abortGraceMs: runtime.codexAbortGraceMs ?? 2_000,
        abortForceCloseMs: runtime.codexAbortForceCloseMs ?? 1_000,
        ...(spawnImpl ? { spawnImpl } : {}),
      });
      return {
        ...result,
        aiExecution: {
          role: policy.role,
          model: policy.model,
          reasoningEffort: policy.reasoningEffort,
        },
      };
    },
  };
}

function safeAiExecution(value) {
  if (
    typeof value?.role !== "string"
    || typeof value?.model !== "string"
    || typeof value?.reasoningEffort !== "string"
  ) {
    return null;
  }
  return {
    role: value.role,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
  };
}

export function createAuditedCodex({ codex, signal, role, audit }) {
  return {
    run: async (options) => {
      const result = await codex.run({ ...options, role, signal });
      const safe = safeAiExecution(result.aiExecution);
      if (safe) audit.aiExecution = safe;
      return result;
    },
  };
}

export async function executeWithCodexAudit(execute) {
  const audit = {};
  let result;
  try {
    result = await execute(audit);
  } catch (error) {
    result = { status: "failed", error: error.message };
  }
  return audit.aiExecution
    ? { ...result, aiExecution: audit.aiExecution }
    : result;
}

export function guardDurableMethods(target, { methods, assertActive }) {
  const guarded = new Set(methods);
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== "function") return value;
      if (!guarded.has(property)) return value.bind(object);
      return async (...args) => {
        await assertActive();
        return Reflect.apply(value, object, args);
      };
    },
  });
}

export function createOrchestratorLifecycle({
  dashboardServer = null,
  miniflare = null,
  clearIntervalImpl = clearInterval,
  log = () => {},
} = {}) {
  let acceptingClaims = true;
  let pollingInterval = null;
  let shutdownPromise = null;
  const activeJobs = new Set();
  const pendingClaims = new Set();
  const signalHandlers = [];

  function setPollingInterval(handle) {
    if (!acceptingClaims) {
      clearIntervalImpl(handle);
      return;
    }
    pollingInterval = handle;
  }

  function canClaim() {
    return acceptingClaims && activeJobs.size === 0 && pendingClaims.size === 0;
  }

  function runJob(job, execute) {
    if (!acceptingClaims) return Promise.resolve(null);
    const controller = new AbortController();
    const active = { job, controller, promise: null };
    active.promise = (async () => execute({ job, signal: controller.signal }))()
      .finally(() => activeJobs.delete(active));
    activeJobs.add(active);
    return active.promise;
  }

  async function claimAndRun({ claim, reconcile, execute }) {
    if (!canClaim()) return null;
    const attempt = (async () => {
      const job = await claim();
      if (!job) return null;
      if (!acceptingClaims) {
        await reconcile?.(job);
        return null;
      }
      void runJob(job, execute).catch((error) => {
        log(`job ${job.id} settlement error: ${error.message}`);
      });
      return job;
    })();
    pendingClaims.add(attempt);
    try {
      return await attempt;
    } finally {
      pendingClaims.delete(attempt);
    }
  }

  function installSignalHandlers(signalTarget = process) {
    for (const signalName of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        void shutdown().catch((error) => log(`shutdown error: ${error.message}`));
      };
      signalTarget.once(signalName, handler);
      signalHandlers.push({ signalTarget, signalName, handler });
    }
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    acceptingClaims = false;
    if (pollingInterval !== null) {
      clearIntervalImpl(pollingInterval);
      pollingInterval = null;
    }
    for (const active of activeJobs) active.controller.abort(new Error("orchestrator shutdown"));
    shutdownPromise = (async () => {
      await Promise.allSettled([...pendingClaims]);
      for (const active of activeJobs) active.controller.abort(new Error("orchestrator shutdown"));
      await Promise.allSettled([...activeJobs].map((active) => active.promise));
      const closeErrors = [];
      try {
        await dashboardServer?.close?.();
      } catch (error) {
        closeErrors.push(error);
      }
      try {
        await miniflare?.dispose?.();
      } catch (error) {
        closeErrors.push(error);
      }
      for (const { signalTarget, signalName, handler } of signalHandlers) {
        signalTarget.off?.(signalName, handler);
      }
      if (closeErrors.length > 0) {
        throw new AggregateError(closeErrors, "orchestrator resource shutdown failed");
      }
    })();
    return shutdownPromise;
  }

  return {
    canClaim,
    claimAndRun,
    installSignalHandlers,
    runJob,
    setPollingInterval,
    shutdown,
  };
}

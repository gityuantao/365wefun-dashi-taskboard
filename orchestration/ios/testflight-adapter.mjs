import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { sanitizeObservedEvidenceString } from "../domain/redaction.mjs";

const execFile = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

function requireCommand(runtime, field) {
  const command = runtime?.[field];
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.trim() === "")) {
    throw new Error(`TestFlight ${field === "iosTestFlightStageCommand" ? "stage" : "readback"} command not configured`);
  }
  return command;
}

function requireString(value, field, prefix) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${prefix} missing ${field}`);
  }
  return value;
}

function observedSnapshot(evidence) {
  const observed = {};
  if (typeof evidence?.processed === "boolean") observed.processed = evidence.processed;
  if (typeof evidence?.processingStatus === "string") {
    observed.processingStatus = sanitizeObservedEvidenceString(evidence.processingStatus);
  }
  if (typeof evidence?.testGroup === "string") {
    observed.testGroup = sanitizeObservedEvidenceString(evidence.testGroup);
  }
  if (typeof evidence?.membershipConfirmed === "boolean") {
    observed.membershipConfirmed = evidence.membershipConfirmed;
  }
  return observed;
}

function readbackError(message, stage, evidence) {
  const error = new Error(message);
  error.name = "TestFlightReadbackError";
  error.stage = stage;
  error.observed = observedSnapshot(evidence);
  return error;
}

function parseLastJsonEvidence(stdout, prefix) {
  const line = String(stdout ?? "").trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error(`${prefix} did not return JSON evidence`);
  try {
    const evidence = JSON.parse(line);
    if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
      throw new Error("not an object");
    }
    return evidence;
  } catch {
    throw new Error(`${prefix} did not return JSON evidence`);
  }
}

function commandEnvironment({ runtime, app, marketingVersion, candidateCommit, staged }) {
  return {
    ...process.env,
    IOS_APP_ID: String(app?.id ?? ""),
    IOS_SCHEME: String(app?.scheme ?? ""),
    IOS_TEST_SCHEME: String(app?.testScheme ?? ""),
    IOS_TEST_TARGET: String(app?.testTarget ?? ""),
    IOS_BUNDLE_ID: String(app?.bundleId ?? ""),
    IOS_MARKETING_VERSION: marketingVersion,
    IOS_TESTFLIGHT_GROUP: String(app?.testFlightGroup ?? ""),
    IOS_TESTFLIGHT_ADAPTER_TIMEOUT_MS: String(timeoutFor(runtime)),
    STAGING_CANDIDATE_COMMIT: String(candidateCommit ?? ""),
    STAGING_REPO_PATH: String(runtime?.repoPath ?? ""),
    ...(staged
      ? {
        IOS_BUILD_NUMBER: String(staged.buildNumber ?? ""),
        IOS_UPLOAD_ID: String(staged.uploadId ?? ""),
      }
      : {}),
  };
}

function timeoutFor(runtime) {
  const timeout = Number(runtime?.iosTestFlightTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;
}

function marketingVersionForIos(targetVersion) {
  return String(targetVersion ?? "").replace(/^v(?=\d+\.\d+\.\d+$)/, "");
}

async function runCommand({ runtime, commandField, projectRoot, environment }) {
  const [file, ...args] = requireCommand(runtime, commandField);
  const { stdout } = await execFile(file, args, {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: timeoutFor(runtime),
    env: environment,
  });
  return stdout;
}

function stageEvidence(evidence, { app, targetVersion }) {
  const expected = {
    appId: String(app?.id ?? ""),
    scheme: String(app?.scheme ?? ""),
    bundleId: String(app?.bundleId ?? ""),
    marketingVersion: String(targetVersion ?? ""),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (evidence[field] !== value) {
      throw new Error(`TestFlight stage evidence ${field} does not match requested App`);
    }
  }
  return {
    ...expected,
    buildNumber: requireString(evidence.buildNumber, "buildNumber", "TestFlight stage evidence"),
    uploadId: requireString(evidence.uploadId, "uploadId", "TestFlight stage evidence"),
  };
}

function readbackEvidence(evidence, { app, staged }) {
  const expected = {
    bundleId: String(app?.bundleId ?? ""),
    marketingVersion: String(staged?.marketingVersion ?? ""),
    buildNumber: String(staged?.buildNumber ?? ""),
    testGroup: String(app?.testFlightGroup ?? ""),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (evidence[field] !== value) {
      throw readbackError(
        `TestFlight readback evidence ${field} does not exactly match staged build`,
        field === "testGroup" ? "internal_testing" : "processing",
        evidence,
      );
    }
  }
  if (evidence.processed !== true) {
    throw readbackError("TestFlight readback evidence is not processed", "processing", evidence);
  }
  if (evidence.processingStatus !== "processed") {
    throw readbackError(
      "TestFlight readback evidence processingStatus is not processed",
      "processing",
      evidence,
    );
  }
  if (evidence.membershipConfirmed !== true) {
    throw readbackError(
      "TestFlight readback evidence does not confirm Internal Testing membership",
      "internal_testing",
      evidence,
    );
  }
  return {
    processed: true,
    processingStatus: "processed",
    testGroup: expected.testGroup,
    membershipConfirmed: true,
    checkedAt: requireString(evidence.checkedAt, "checkedAt", "TestFlight readback evidence"),
  };
}

export function createTestFlightAdapter({ runtime = {}, projectRoot } = {}) {
  return {
    async stage({ candidateCommit, targetVersion, app }) {
      const marketingVersion = marketingVersionForIos(targetVersion);
      const stdout = await runCommand({
        runtime,
        commandField: "iosTestFlightStageCommand",
        projectRoot,
        environment: commandEnvironment({ runtime, app, marketingVersion, candidateCommit }),
      });
      return stageEvidence(parseLastJsonEvidence(stdout, "TestFlight stage command"), {
        app,
        targetVersion: marketingVersion,
      });
    },
    async readback({ app, staged }) {
      const stdout = await runCommand({
        runtime,
        commandField: "iosTestFlightReadbackCommand",
        projectRoot,
        environment: commandEnvironment({
          runtime,
          app,
          marketingVersion: String(staged?.marketingVersion ?? ""),
          staged,
        }),
      });
      return readbackEvidence(parseLastJsonEvidence(stdout, "TestFlight readback command"), { app, staged });
    },
  };
}

import path from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { redactCredentials } from "../domain/redaction.mjs";
import { loadIosApps } from "../ios/app-registry.mjs";

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
}

function command(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== "string" || part.trim() === "")) {
    throw new Error(`${field} must be a non-empty command array`);
  }
}

function positiveNumber(value, field) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error(`${field} must be positive`);
}

function httpsUrl(value, field) {
  nonEmptyString(value, field);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${field} must be a credential-free HTTPS URL`);
  }
}

export function validateProductionRuntime(runtime, { projectRoot = null, pathExists = existsSync } = {}) {
  try {
    nonEmptyString(runtime?.deviceId, "deviceId");
    nonEmptyString(runtime?.releaseAdapterModule, "releaseAdapterModule");
    nonEmptyString(runtime?.iosProductionReleaseAdapterModule, "iosProductionReleaseAdapterModule");
    command(runtime?.productionReleaseCommand, "productionReleaseCommand");
    nonEmptyString(runtime?.productionConfigPath, "productionConfigPath");
    positiveNumber(runtime?.productionReleaseTimeoutMs, "productionReleaseTimeoutMs");
    command(runtime?.iosProductionReleaseCommand, "iosProductionReleaseCommand");
    nonEmptyString(runtime?.iosProductionCredentialsPath, "iosProductionCredentialsPath");
    httpsUrl(runtime?.iosProductionApiUrl, "iosProductionApiUrl");
    positiveNumber(runtime?.iosProductionReleaseTimeoutMs, "iosProductionReleaseTimeoutMs");
    positiveNumber(runtime?.productionReleaseLeaseMs, "productionReleaseLeaseMs");
    positiveNumber(runtime?.productionReleaseMaxReconciliationAttempts, "productionReleaseMaxReconciliationAttempts");
    if (!Array.isArray(runtime?.iosApps) || runtime.iosApps.length === 0) {
      throw new Error("iosApps must include at least one enabled App");
    }
    loadIosApps(runtime.iosApps);
    if (projectRoot) {
      for (const field of ["releaseAdapterModule", "iosProductionReleaseAdapterModule"]) {
        if (!pathExists(path.resolve(projectRoot, runtime[field]))) {
          throw new Error(`${field} does not exist`);
        }
      }
      for (const field of ["productionConfigPath", "iosProductionCredentialsPath"]) {
        if (!pathExists(path.resolve(runtime[field]))) throw new Error(`${field} does not exist`);
      }
      for (const field of ["productionReleaseCommand", "iosProductionReleaseCommand"]) {
        const [program, script] = runtime[field];
        if (path.basename(program) === "node" && script && !pathExists(path.resolve(projectRoot, script))) {
          throw new Error(`${field} target does not exist`);
        }
      }
    }
    if (runtime.productionReleaseHold !== false) {
      return Object.freeze({
        ready: false,
        held: true,
        error: "production release hold is enabled",
      });
    }
    return Object.freeze({ ready: true, error: null });
  } catch (error) {
    return Object.freeze({
      ready: false,
      ...(runtime?.productionReleaseHold !== false ? { held: true } : {}),
      error: redactCredentials(error.message),
    });
  }
}

function assertAdapter(adapter, fields, label) {
  if (!adapter || adapter.placeholder === true || fields.some((field) => typeof adapter[field] !== "function")) {
    throw new Error(`${label} factory returned an invalid adapter`);
  }
  return adapter;
}

function unavailable(error) {
  const wrapped = new Error(`production runtime adapter unavailable: ${redactCredentials(error?.message ?? error)}`);
  wrapped.code = "PRODUCTION_RUNTIME_ADAPTER_UNAVAILABLE";
  wrapped.failureClassification = "release_infrastructure";
  wrapped.deterministic = true;
  return wrapped;
}

export function createProductionRuntime({
  runtime,
  projectRoot,
  importModule = (url) => import(url),
  pathExists = existsSync,
} = {}) {
  const readiness = validateProductionRuntime(runtime, { projectRoot, pathExists });
  let configuredApps = Object.freeze([]);
  try {
    configuredApps = Object.freeze(loadIosApps(runtime?.iosApps).map((app) => Object.freeze({
      id: app.id,
      name: app.name,
      enabled: app.enabled,
      appStoreAppId: app.appStoreAppId,
      scheme: app.scheme,
      testScheme: app.testScheme,
      testTarget: app.testTarget,
      bundleId: app.bundleId,
      testFlightGroup: app.testFlightGroup,
      buildNumberSource: app.buildNumberSource,
      releaseMode: app.releaseMode,
    })));
  } catch {
    configuredApps = Object.freeze([]);
  }
  const apps = readiness.ready ? loadIosApps(runtime.iosApps) : Object.freeze([]);
  let loaded = null;

  const invoke = (adapterName, method) => async (...args) => {
    const adapters = await boundary.loadAdapters();
    return adapters[adapterName][method](...args);
  };

  const boundary = {
    readiness,
    apps,
    configuredApps,
    async loadAdapters() {
      if (!readiness.ready) throw unavailable(new Error(readiness.error));
      if (loaded) return loaded;
      try {
        const webUrl = pathToFileURL(path.resolve(projectRoot, runtime.releaseAdapterModule)).href;
        const iosUrl = pathToFileURL(path.resolve(projectRoot, runtime.iosProductionReleaseAdapterModule)).href;
        const [webModule, iosModule] = await Promise.all([
          importModule(webUrl),
          importModule(iosUrl),
        ]);
        if (typeof webModule.createReleaseAdapter !== "function") {
          throw new Error("releaseAdapterModule must export createReleaseAdapter");
        }
        if (typeof iosModule.createAppStoreReleaseAdapter !== "function") {
          throw new Error("iosProductionReleaseAdapterModule must export createAppStoreReleaseAdapter");
        }
        const webAdapter = assertAdapter(
          await webModule.createReleaseAdapter({ runtime, projectRoot }),
          ["collectRegressionEvidence", "identifyArtifact", "release", "readback"],
          "Web/API production adapter",
        );
        const iosAdapter = assertAdapter(
          await iosModule.createAppStoreReleaseAdapter({ runtime, projectRoot }),
          ["release", "readback"],
          "iOS production adapter",
        );
        loaded = Object.freeze({ webAdapter, iosAdapter });
        return loaded;
      } catch (error) {
        throw unavailable(error);
      }
    },
    async probeReadiness() {
      const current = validateProductionRuntime(runtime, { projectRoot, pathExists });
      if (!current.ready) return current;
      try {
        await boundary.loadAdapters();
        return Object.freeze({ ready: true, error: null });
      } catch (error) {
        return Object.freeze({ ready: false, error: redactCredentials(error.message) });
      }
    },
    releaseLease(now = () => new Date().toISOString()) {
      return Object.freeze({
        holder: runtime.deviceId,
        durationMs: Number(runtime.productionReleaseLeaseMs),
        maxReconciliationAttempts: Number(runtime.productionReleaseMaxReconciliationAttempts),
        now,
      });
    },
  };
  boundary.webAdapter = Object.freeze({
    collectRegressionEvidence: invoke("webAdapter", "collectRegressionEvidence"),
    identifyArtifact: invoke("webAdapter", "identifyArtifact"),
    release: invoke("webAdapter", "release"),
    readback: invoke("webAdapter", "readback"),
  });
  boundary.iosAdapter = Object.freeze({
    release: invoke("iosAdapter", "release"),
    readback: invoke("iosAdapter", "readback"),
  });
  return Object.freeze(boundary);
}

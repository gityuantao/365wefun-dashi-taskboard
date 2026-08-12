#!/usr/bin/env node

import fs from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { redactCredentials, sanitizeObservedEvidenceString } from "../orchestration/domain/redaction.mjs";

import { buildExportCommand, buildUploadCommand, createAppStoreConnectClient, createOperationControl, extractUploadIdentifier, runCommand, verifyAppBundle, withAppBuildReservation, withCandidateWorktree } from "./stage-all-ios-apps.mjs";

const MODES = new Set(["test", "archive", "upload", "processing", "configure_version", "configure_review", "ensure_review", "ensure_review_item", "submit_review", "read_review", "read_live"]);
const WAITING = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW", "PENDING_DEVELOPER_RELEASE", "PREPARE_FOR_SUBMISSION"]);

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`iOS production configuration missing ${field}`);
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveNumber(value, field) {
  const number = Number(requireString(value, field));
  if (!Number.isFinite(number) || number <= 0) throw new Error(`iOS production configuration ${field} must be positive`);
  return number;
}

function positiveInteger(value, field) {
  const result = requireString(value, field);
  if (!/^[1-9]\d*$/.test(result)) throw new Error(`iOS production configuration ${field} must be a positive integer`);
  return result;
}

function assertIdentifier(value, field) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`iOS production configuration ${field} is invalid`);
}

export function validateProductionEnvironment(environment, { checkFilesystem = true } = {}) {
  const mode = requireString(environment.IOS_PRODUCTION_MODE, "IOS_PRODUCTION_MODE");
  if (!MODES.has(mode)) throw new Error("iOS production configuration IOS_PRODUCTION_MODE is invalid");
  const app = {
    id: requireString(environment.IOS_APP_ID, "IOS_APP_ID"),
    scheme: requireString(environment.IOS_SCHEME, "IOS_SCHEME"),
    testScheme: requireString(environment.IOS_TEST_SCHEME, "IOS_TEST_SCHEME"),
    testTarget: requireString(environment.IOS_TEST_TARGET, "IOS_TEST_TARGET"),
    bundleId: requireString(environment.IOS_BUNDLE_ID, "IOS_BUNDLE_ID"),
    appStoreAppId: requireString(environment.IOS_APP_STORE_APP_ID, "IOS_APP_STORE_APP_ID"),
    releaseMode: requireString(environment.IOS_RELEASE_MODE, "IOS_RELEASE_MODE"),
    reviewConfigurationRef: requireString(environment.IOS_REVIEW_CONFIGURATION_REF, "IOS_REVIEW_CONFIGURATION_REF"),
  };
  for (const field of ["id", "scheme", "testScheme", "testTarget", "appStoreAppId"]) assertIdentifier(app[field], field);
  if (app.releaseMode !== "automatic") throw new Error("iOS production release mode must be automatic");
  if (!/^[A-Za-z0-9.-]+$/.test(app.bundleId)) throw new Error("iOS production bundle ID is invalid");
  const credentialsPath = path.resolve(requireString(environment.IOS_PRODUCTION_CREDENTIALS_PATH, "IOS_PRODUCTION_CREDENTIALS_PATH"));
  if (checkFilesystem) {
    const stat = fs.statSync(credentialsPath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("iOS production credentials file must be private");
  }
  const requiresBuild = mode !== "test";
  const config = {
    mode, app, credentialsPath,
    marketingVersion: requireString(environment.IOS_MARKETING_VERSION, "IOS_MARKETING_VERSION"),
    buildNumber: requiresBuild ? positiveInteger(environment.IOS_BUILD_NUMBER, "IOS_BUILD_NUMBER") : optionalString(environment.IOS_BUILD_NUMBER),
    uploadId: ["configure_version", "ensure_review", "ensure_review_item", "submit_review", "read_live"].includes(mode) ? requireString(environment.IOS_UPLOAD_ID, "IOS_UPLOAD_ID") : optionalString(environment.IOS_UPLOAD_ID),
    processingId: ["submit_review", "read_review", "read_live"].includes(mode) ? requireString(environment.IOS_PROCESSING_ID, "IOS_PROCESSING_ID") : optionalString(environment.IOS_PROCESSING_ID),
    reviewSubmissionId: mode === "read_live" ? requireString(environment.IOS_REVIEW_SUBMISSION_ID, "IOS_REVIEW_SUBMISSION_ID") : optionalString(environment.IOS_REVIEW_SUBMISSION_ID),
    appStoreVersionId: optionalString(environment.IOS_APP_STORE_VERSION_ID),
    reviewItemId: optionalString(environment.IOS_REVIEW_ITEM_ID),
    externalRequestId: optionalString(environment.IOS_EXTERNAL_REQUEST_ID),
    reviewId: optionalString(environment.IOS_REVIEW_ID),
    releaseId: optionalString(environment.IOS_RELEASE_ID),
    repoPath: path.resolve(optionalString(environment.IOS_PRODUCTION_REPO_PATH) || "."),
    candidateCommit: requireString(environment.PRODUCTION_CANDIDATE_COMMIT, "PRODUCTION_CANDIDATE_COMMIT"),
    versionId: requireString(environment.PRODUCTION_VERSION_ID, "PRODUCTION_VERSION_ID"),
    manifestChecksum: requireString(environment.PRODUCTION_MANIFEST_CHECKSUM, "PRODUCTION_MANIFEST_CHECKSUM"),
    idempotencyKey: requireString(environment.IOS_PRODUCTION_IDEMPOTENCY_KEY, "IOS_PRODUCTION_IDEMPOTENCY_KEY"),
    productionApiUrl: requireString(environment.IOS_PRODUCTION_API_URL, "IOS_PRODUCTION_API_URL"),
    testDestination: optionalString(environment.IOS_TEST_DESTINATION) || "platform=iOS Simulator,name=iPhone 17 Pro",
    adapterTimeoutMs: positiveNumber(environment.IOS_PRODUCTION_ADAPTER_TIMEOUT_MS ?? "2700000", "IOS_PRODUCTION_ADAPTER_TIMEOUT_MS"),
    internalTimeoutMs: positiveNumber(environment.IOS_PRODUCTION_INTERNAL_TIMEOUT_MS ?? "2695000", "IOS_PRODUCTION_INTERNAL_TIMEOUT_MS"),
  };
  if (config.internalTimeoutMs >= config.adapterTimeoutMs) throw new Error("iOS production internal deadline must be shorter than adapter timeout");
  if (!/^\d+\.\d+\.\d+$/.test(config.marketingVersion)) throw new Error("iOS production marketing version is invalid");
  if (!/^[0-9a-f]{40}$/.test(config.candidateCommit)) throw new Error("iOS production Candidate must be a full Git SHA");
  return config;
}

function identitySettings(context) {
  return [
    `MARKETING_VERSION=${context.marketingVersion}`,
    `CURRENT_PROJECT_VERSION=${context.buildNumber}`,
    `PRODUCT_BUNDLE_IDENTIFIER=${context.app.bundleId}`,
    `API_BASE_URL=${context.productionApiUrl}`,
  ];
}

export function buildProductionTestCommand(context) {
  return { file: "xcodebuild", cwd: context.iosDirectory, args: [
    "test", "-project", context.projectPath, "-scheme", context.app.testScheme,
    "-configuration", "Debug", "-destination", context.testDestination,
    "-derivedDataPath", context.derivedDataPath, `-only-testing:${context.app.testTarget}`,
    ...identitySettings(context),
  ] };
}

export function buildProductionArchiveCommand(context) {
  return { file: "xcodebuild", cwd: context.iosDirectory, args: [
    "archive", "-project", context.projectPath, "-scheme", context.app.scheme,
    "-configuration", "Release", "-destination", "generic/platform=iOS",
    "-archivePath", context.archivePath, "-derivedDataPath", context.derivedDataPath,
    "-allowProvisioningUpdates", ...identitySettings(context),
  ] };
}

export function buildReviewSubmissionRequest({ app, buildId, versionId }) {
  return {
    path: "/v1/reviewSubmissions", method: "POST",
    body: { data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: {
      app: { data: { type: "apps", id: app.appStoreAppId } },
    } } },
    versionRequest: {
      path: `/v1/appStoreVersions/${encodeURIComponent(versionId)}`, method: "PATCH",
      body: { data: { type: "appStoreVersions", id: versionId, attributes: { releaseType: "AFTER_APPROVAL" }, relationships: { build: { data: { type: "builds", id: buildId } } } } },
    },
  };
}

export async function releaseAllIosApps({ apps, executeApp }) {
  const results = [];
  for (const app of apps) if (app?.enabled === true) results.push(await executeApp(app));
  return results;
}

function exactAppQuery(config) {
  return `/v1/apps/${encodeURIComponent(config.app.appStoreAppId)}`;
}

function exactVersionQuery(config) {
  const query = new URLSearchParams({ "filter[app]": config.app.appStoreAppId, "filter[versionString]": config.marketingVersion, "filter[platform]": "IOS", limit: "2" });
  return `/v1/appStoreVersions?${query}`;
}

function evidence(config, extra = {}) {
  return { appId: config.app.id, appStoreAppId: config.app.appStoreAppId, scheme: config.app.scheme, bundleId: config.app.bundleId, marketingVersion: config.marketingVersion, buildNumber: config.buildNumber, uploadId: config.uploadId, externalRequestId: config.externalRequestId, processingId: config.processingId, appStoreVersionId: config.appStoreVersionId, reviewSubmissionId: config.reviewSubmissionId, reviewItemId: config.reviewItemId, ...extra, checkedAt: new Date().toISOString() };
}

async function credentials(config) {
  const value = JSON.parse(await readFile(config.credentialsPath, "utf8"));
  const keyId = requireString(value.keyId, "credentials.keyId");
  const privateKeyPath = path.resolve(requireString(value.privateKeyPath, "credentials.privateKeyPath"));
  const privateKeyStat = fs.statSync(privateKeyPath);
  if (!privateKeyStat.isFile() || path.basename(privateKeyPath) !== `AuthKey_${keyId}.p8` || (privateKeyStat.mode & 0o077) !== 0) {
    throw new Error("App Store Connect private key must be the exact private AuthKey file");
  }
  return { keyId, issuerId: requireString(value.issuerId, "credentials.issuerId"), privateKeyPath, reviewConfigurations: value.reviewConfigurations };
}

const REVIEW_DETAIL_FIELDS = new Set(["contactFirstName", "contactLastName", "contactPhone", "contactEmail", "demoAccountName", "demoAccountRequired", "demoAccountPassword", "notes"]);

export function resolveReviewConfiguration(configurations, ref) {
  if (!configurations || typeof configurations !== "object" || Array.isArray(configurations) || !Object.hasOwn(configurations, ref)) throw new Error("configured App Store review configuration reference is missing");
  const configuration = configurations[ref];
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) throw new Error("App Store review configuration must be an object");
  const attributes = configuration.reviewDetailAttributes;
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes) || Object.keys(attributes).length === 0) throw new Error("App Store review detail attributes are required");
  for (const [field, value] of Object.entries(attributes)) {
    if (!REVIEW_DETAIL_FIELDS.has(field) || (typeof value !== "string" && typeof value !== "boolean")) throw new Error("App Store review detail attributes contain an unsupported field or value");
  }
  return Object.freeze({ reviewDetailAttributes: Object.freeze({ ...attributes }) });
}

async function asc(config, signal) {
  return createAppStoreConnectClient(await credentials(config), { signal });
}

export async function waitForProcessedBuild({ client, appResourceId, marketingVersion, buildNumber, maxAttempts = 100, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pollIntervalMs = 15_000, returnAuthoritativeAbsence = false }) {
  let observedBuild = false;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const build = await client.findExactBuild({ appResourceId, marketingVersion, buildNumber });
    if (build) observedBuild = true;
    const state = build?.attributes?.processingState;
    if (state === "VALID") return build;
    if (state === "FAILED" || state === "INVALID") throw new Error("App Store build processing failed");
    if (attempt + 1 < maxAttempts) await sleep(pollIntervalMs);
  }
  if (returnAuthoritativeAbsence && !observedBuild) return null;
  throw new Error("App Store build processing did not complete before the polling limit");
}

export function confirmsExactLiveBuild({ versionState, exactBuild, relatedBuild, processingId }) {
  return versionState === "READY_FOR_SALE"
    && Boolean(exactBuild?.id)
    && relatedBuild?.id === exactBuild.id
    && relatedBuild.id === processingId
    && String(relatedBuild?.attributes?.version ?? "") === String(exactBuild?.attributes?.version ?? "");
}

function singleResource(response, label) {
  if (!Array.isArray(response?.data) || response.data.length !== 1) throw new Error(`App Store Connect did not return exactly one ${label}`);
  return response.data[0];
}

async function execute(config, signal) {
  const root = path.join(os.tmpdir(), "365wefun-production-ios", config.manifestChecksum, config.app.id);
  if (config.mode === "test") {
    const client = await asc(config, signal);
    const app = await client.request(exactAppQuery(config));
    if (app?.data?.id !== config.app.appStoreAppId || app?.data?.attributes?.bundleId !== config.app.bundleId) throw new Error("App Store App ID and bundle ID do not match");
    return withAppBuildReservation({
      lockRoot: path.join(os.tmpdir(), "365wefun-production-ios-locks"), app: config.app, signal,
      fetchRemoteBuilds: () => client.listBuilds(config.app.appStoreAppId),
      operation: (buildNumber) => withCandidateWorktree({
        repoPath: config.repoPath, candidateCommit: config.candidateCommit, signal,
        operation: async (candidatePath) => {
          const iosDirectory = path.join(candidatePath, "apps", "ios");
          await runCommand({ file: "xcodegen", args: ["generate", "--spec", "project.yml"], cwd: iosDirectory }, "production iOS project generation", { signal });
          await runCommand(buildProductionTestCommand({ ...config, buildNumber, iosDirectory, projectPath: path.join(iosDirectory, "E365.xcodeproj"), derivedDataPath: path.join(root, "DerivedData") }), "production iOS automated tests", { signal });
          return evidence({ ...config, buildNumber });
        },
      }),
    });
  }
  if (config.mode === "archive") {
    return withCandidateWorktree({
      repoPath: config.repoPath, candidateCommit: config.candidateCommit, signal,
      operation: async (candidatePath) => {
        const iosDirectory = path.join(candidatePath, "apps", "ios");
        await runCommand({ file: "xcodegen", args: ["generate", "--spec", "project.yml"], cwd: iosDirectory }, "production iOS project generation", { signal });
        await mkdir(root, { recursive: true });
        const archivePath = path.join(root, `${config.app.scheme}.xcarchive`);
        const archiveContext = { ...config, apiUrl: config.productionApiUrl, iosDirectory, projectPath: path.join(iosDirectory, "E365.xcodeproj"), derivedDataPath: path.join(root, "DerivedData"), archivePath };
        await runCommand(buildProductionArchiveCommand(archiveContext), "production iOS archive", { signal });
        const applicationsPath = path.join(archivePath, "Products", "Applications");
        const appBundles = fs.readdirSync(applicationsPath, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
        if (appBundles.length !== 1) throw new Error("production archive must contain exactly one App bundle");
        const archiveIdentity = await verifyAppBundle(path.join(applicationsPath, appBundles[0].name), archiveContext, "Production archive", signal);
        await writeFile(path.join(root, "archive-identity.json"), `${JSON.stringify(archiveIdentity)}\n`, { mode: 0o600 });
        return evidence(config);
      },
    });
  }
  const iosDirectory = path.join(config.repoPath, "apps", "ios");
  const context = { ...config, apiUrl: config.productionApiUrl, iosDirectory, projectPath: path.join(iosDirectory, "E365.xcodeproj"), derivedDataPath: path.join(root, "DerivedData"), archivePath: path.join(root, `${config.app.scheme}.xcarchive`) };
  const client = await asc(config, signal);
  if (config.mode === "upload") {
    await mkdir(root, { recursive: true });
    const exportPath = path.join(root, "export");
    const exportOptionsPath = path.join(root, "ExportOptions.plist");
    await writeFile(exportOptionsPath, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>destination</key><string>export</string><key>manageAppVersionAndBuildNumber</key><false/><key>method</key><string>app-store-connect</string><key>signingStyle</key><string>automatic</string><key>uploadSymbols</key><true/></dict></plist>\n`, { mode: 0o600 });
    await runCommand(buildExportCommand({ paths: { archivePath: context.archivePath, exportPath, exportOptionsPath, iosDirectory } }), "production iOS export", { signal });
    const ipaPath = path.join(exportPath, `${config.app.scheme}.ipa`);
    if (!fs.existsSync(ipaPath)) throw new Error("production iOS export did not create the expected IPA");
    const expandedPath = path.join(root, "ipa-expanded");
    await rm(expandedPath, { recursive: true, force: true });
    await mkdir(expandedPath, { recursive: true });
    await runCommand({ file: "unzip", args: ["-q", ipaPath, "-d", expandedPath], cwd: root }, "production IPA inspection", { signal });
    const payloadPath = path.join(expandedPath, "Payload");
    const appBundles = fs.readdirSync(payloadPath, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
    if (appBundles.length !== 1) throw new Error("production IPA must contain exactly one App bundle");
    const ipaIdentity = await verifyAppBundle(path.join(payloadPath, appBundles[0].name), context, "Production IPA", signal);
    const archiveIdentity = JSON.parse(await readFile(path.join(root, "archive-identity.json"), "utf8"));
    if (JSON.stringify(archiveIdentity) !== JSON.stringify(ipaIdentity)) throw new Error("production Archive and IPA identities do not exactly match");
    const apple = await credentials(config);
    const uploaded = await runCommand(buildUploadCommand({ ipaPath, keyId: apple.keyId, issuerId: apple.issuerId, privateKeyPath: apple.privateKeyPath }), "production App Store upload", { signal });
    const externalRequestId = extractUploadIdentifier(uploaded.stdout, "");
    return evidence(config, { uploadId: externalRequestId, externalRequestId });
  }
  if (config.mode === "processing") {
    const build = await waitForProcessedBuild({ client, appResourceId: config.app.appStoreAppId, marketingVersion: config.marketingVersion, buildNumber: config.buildNumber, returnAuthoritativeAbsence: true });
    if (!build) return evidence(config, { status: "absent", authoritative: true, submissionExists: false });
    return evidence(config, { uploadId: config.uploadId || build.id, externalRequestId: config.externalRequestId || `asc-build:${build.id}`, processingId: build.id, processingStatus: "processed", authoritative: true });
  }
  if (["configure_version", "configure_review", "ensure_review", "ensure_review_item", "submit_review"].includes(config.mode)) {
    const version = singleResource(await client.request(exactVersionQuery(config)), "App Store version");
    const request = buildReviewSubmissionRequest({ app: config.app, buildId: config.processingId, versionId: version.id });
    if (config.mode === "configure_version") {
      await client.request(request.versionRequest.path, { method: request.versionRequest.method, body: request.versionRequest.body });
      const confirmedVersion = singleResource(await client.request(exactVersionQuery(config)), "configured App Store version");
      if (confirmedVersion.id !== version.id || confirmedVersion.attributes?.releaseType !== "AFTER_APPROVAL") throw new Error("automatic App Store release configuration was not confirmed");
      return evidence(config, { appStoreVersionId: version.id, automaticRelease: true, authoritative: true });
    }
    if (config.mode === "configure_review") {
      const settings = await credentials(config);
      const reviewConfiguration = resolveReviewConfiguration(settings.reviewConfigurations, config.app.reviewConfigurationRef);
      const detail = (await client.request(`/v1/appStoreVersions/${encodeURIComponent(version.id)}/appStoreReviewDetail`))?.data;
      const detailId = requireString(detail?.id, "App Store review detail ID");
      await client.request(`/v1/appStoreReviewDetails/${encodeURIComponent(detailId)}`, { method: "PATCH", body: { data: { type: "appStoreReviewDetails", id: detailId, attributes: reviewConfiguration.reviewDetailAttributes } } });
      const confirmed = (await client.request(`/v1/appStoreReviewDetails/${encodeURIComponent(detailId)}`))?.data;
      if (confirmed?.id !== detailId) throw new Error("App Store review detail update was not confirmed");
      for (const [field, value] of Object.entries(reviewConfiguration.reviewDetailAttributes)) {
        if (field !== "demoAccountPassword" && confirmed?.attributes?.[field] !== value) throw new Error("App Store review detail does not match the configured reference");
      }
      return evidence(config, { appStoreVersionId: version.id, reviewConfigurationApplied: true, automaticRelease: true, authoritative: true });
    }
    const itemQuery = `/v1/reviewSubmissionItems?filter[appStoreVersion]=${encodeURIComponent(version.id)}&include=reviewSubmission&limit=2`;
    const existing = await client.request(itemQuery);
    let submission = existing?.included?.find((item) => item?.type === "reviewSubmissions");
    if (!submission && config.reviewSubmissionId) {
      const exact = await client.request(`/v1/reviewSubmissions/${encodeURIComponent(config.reviewSubmissionId)}`);
      if (exact?.data?.id === config.reviewSubmissionId) submission = exact.data;
    }
    if (config.mode === "ensure_review") {
      if (!submission) {
        const open = await client.request(`/v1/reviewSubmissions?filter[app]=${encodeURIComponent(config.app.appStoreAppId)}&filter[platform]=IOS&limit=200`);
        const reusable = open?.data?.filter((candidate) => candidate?.attributes?.submitted !== true) ?? [];
        if (reusable.length > 0) throw new Error("an unbound open App Store review submission prevents deterministic recovery");
      }
      if (!submission) {
        submission = (await client.request(request.path, { method: request.method, body: request.body }))?.data;
      }
      return evidence(config, { appStoreVersionId: version.id, reviewSubmissionId: requireString(submission?.id, "review submission ID"), automaticRelease: true });
    }
    if (!submission) throw new Error("review submission must exist before adding its exact version item");
    const submissionId = requireString(submission.id, "review submission ID");
    let reviewItem = existing?.data?.find((item) => item?.relationships?.reviewSubmission?.data?.id === submissionId) ?? existing?.data?.[0];
    if (config.mode === "ensure_review_item") {
      if (!reviewItem) {
        reviewItem = (await client.request("/v1/reviewSubmissionItems", { method: "POST", body: { data: { type: "reviewSubmissionItems", relationships: { reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } }, appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } } } } }))?.data;
      }
      return evidence(config, { appStoreVersionId: version.id, reviewSubmissionId: submissionId, reviewItemId: requireString(reviewItem?.id, "review submission item ID"), automaticRelease: true });
    }
    if (!reviewItem && !config.reviewItemId) throw new Error("review submission item must exist before submission");
    if (submission?.attributes?.submitted !== true) {
      await client.request(`/v1/reviewSubmissions/${encodeURIComponent(submissionId)}`, { method: "PATCH", body: { data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } } } });
    }
    const confirmed = await client.request(`/v1/reviewSubmissions/${encodeURIComponent(submissionId)}`);
    if (confirmed?.data?.id !== submissionId || confirmed?.data?.attributes?.submitted !== true) throw new Error("App Store review submission was not authoritatively confirmed");
    return evidence(config, { appStoreVersionId: version.id, reviewSubmissionId: submissionId, reviewItemId: reviewItem?.id ?? config.reviewItemId, reviewStatus: "submitted", automaticRelease: true, authoritative: true, submissionExists: true });
  }
  if (config.mode === "read_review") {
    let item;
    if (config.reviewSubmissionId) {
      item = (await client.request(`/v1/reviewSubmissions/${encodeURIComponent(config.reviewSubmissionId)}`))?.data;
      if (!item || item.id !== config.reviewSubmissionId) throw new Error("App Store review submission is absent");
    } else {
      const version = singleResource(await client.request(exactVersionQuery(config)), "App Store version");
      const response = await client.request(`/v1/reviewSubmissionItems?filter[appStoreVersion]=${encodeURIComponent(version.id)}&include=reviewSubmission&limit=2`);
      item = response?.included?.find((candidate) => candidate?.type === "reviewSubmissions");
      if (!item) return evidence(config, { status: "absent", authoritative: true, submissionExists: false });
    }
    const version = singleResource(await client.request(exactVersionQuery(config)), "App Store version");
    const automaticRelease = version.attributes?.releaseType === "AFTER_APPROVAL";
    const state = String(item.attributes?.state ?? "").toUpperCase();
    if (![...WAITING, "COMPLETE", "REJECTED"].includes(state)) throw new Error(`App Store review returned unsupported state ${state || "empty"}`);
    const reviewStatus = state === "COMPLETE" ? "approved" : state === "REJECTED" ? "rejected" : state.toLowerCase();
    return evidence(config, { reviewSubmissionId: item.id, reviewStatus, reviewId: item.id, releaseStatus: reviewStatus === "approved" ? "waiting" : "pending", automaticRelease, authoritative: true, submissionExists: true });
  }
  const version = singleResource(await client.request(exactVersionQuery(config)), "live App Store version");
  const state = String(version.attributes?.appStoreState ?? "");
  const liveBuild = await client.findExactBuild({ appResourceId: config.app.appStoreAppId, marketingVersion: config.marketingVersion, buildNumber: config.buildNumber });
  const relatedBuild = (await client.request(`/v1/appStoreVersions/${encodeURIComponent(version.id)}/build`))?.data;
  const liveMembershipConfirmed = confirmsExactLiveBuild({ versionState: state, exactBuild: liveBuild, relatedBuild, processingId: config.processingId });
  return evidence(config, { reviewStatus: "approved", reviewId: config.reviewId, releaseStatus: state === "READY_FOR_SALE" ? "released" : "waiting", releaseId: config.releaseId || version.id, liveStatus: state === "READY_FOR_SALE" ? "live" : "waiting", liveId: version.id, liveMarketingVersion: version.attributes?.versionString, liveBuildNumber: relatedBuild?.attributes?.version, automaticRelease: true, authoritative: true, liveMembershipConfirmed });
}

async function main() {
  const config = validateProductionEnvironment(process.env);
  const control = createOperationControl(config);
  try {
    console.log(JSON.stringify(await execute(config, control.signal)));
  } catch (error) {
    const message = String(error?.message ?? "iOS production release command failed");
    const deterministic = /automated tests|artifact|archive|IPA|bundle|debug|StoreKit|private key|configuration|processing failed|invalid/i.test(message);
    const safeMessage = sanitizeObservedEvidenceString(redactCredentials(message));
    console.log(JSON.stringify({ ok: false, error: {
      deterministic,
      classification: deterministic ? "validation" : "external_unknown",
      message: deterministic ? `iOS production validation failed: ${safeMessage}` : "iOS production external outcome requires reconciliation",
    } }));
  } finally {
    control.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.log(JSON.stringify({ ok: false, error: { deterministic: true, classification: "validation", message: "iOS production configuration failed" } })); });
}

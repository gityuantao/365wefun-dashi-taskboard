import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { createDomainEvent } from "../../orchestration/domain/events.mjs";
import { appendCommandResult } from "../../orchestration/persistence/d1-event-store.mjs";
import { freezeManifest } from "../../orchestration/release/version-aggregator.mjs";
import { saveSnapshot } from "../../orchestration/clickup/snapshot.mjs";
import { handleConfirmRelease } from "../../orchestration/application/release-commands.mjs";
import { createWebAdapter } from "../../orchestration/release/adapters/web.mjs";

const NOW = "2026-08-04T00:07:00.000Z";
const CANDIDATE_COMMIT = "1111111111111111111111111111111111111111";
const ARTIFACT_IDENTITY = {
  digest: "sha256:artifact-v1",
  object: "releases/version-1/sha256:artifact-v1",
};

function deterministicReleaseError(message) {
  const error = new Error(message);
  error.deterministic = true;
  error.failureClassification = "release_infrastructure";
  return error;
}

function webSubmission() {
  return {
    externalRequestId: "web-request-1",
    productionReleaseId: "web-release-1",
    artifactIdentity: ARTIFACT_IDENTITY,
    observedEvidence: { releaseId: "web-release-1" },
    url: "https://releases.example.com/v1",
  };
}

function webPublication(candidateCommit = CANDIDATE_COMMIT, artifactIdentity = ARTIFACT_IDENTITY) {
  return {
    confirmed: true,
    published: true,
    status: "published",
    authoritative: true,
    candidateCommit,
    artifactIdentity,
    productionReleaseId: "web-release-1",
    healthStatus: "healthy",
    readbackStatus: "confirmed",
    observedEvidence: { releaseId: "web-release-1" },
    readbackEvidence: { candidateCommit, healthStatus: "healthy" },
  };
}

async function seedVersion(harness, versionId) {
  const event = await createDomainEvent({
    id: `rel-seed-${versionId}-1`,
    sequence: 1,
    aggregateType: "version",
    aggregateId: versionId,
    aggregateVersion: 1,
    type: "version.activated",
    commandId: `rel-seed-cmd-${versionId}-1`,
    actorId: "system",
    occurredAt: NOW,
    data: { from: "planning", to: "active" },
    previousHash: null,
  });
  await appendCommandResult(harness.db, {
    command: parseCommandEnvelope({
      id: `rel-seed-cmd-${versionId}-1`,
      type: "activate_version",
      aggregateType: "version",
      aggregateId: versionId,
      expectedVersion: 1,
      actorId: "system",
      issuedAt: NOW,
      reason: "seed",
      parameters: {},
    }),
    events: [event],
    projection: { state: "active", snapshot: { kind: "version" } },
  });
}

async function seedTaskToRelease(harness, taskId, platforms = ["web"]) {
  for (let index = 0; index < 7; index += 1) {
    const type = ["start_analysis", "analysis_completed", "start_development",
      "development_completed", "acceptance_passed", "start_test",
      "test_passed"][index];
    await dispatchCommand({
      db: harness.db,
      command: parseCommandEnvelope({
        id: `rel-task-${taskId}-${index}`,
        type,
        aggregateType: "task",
        aggregateId: taskId,
        expectedVersion: index + 1,
        actorId: "system",
        issuedAt: NOW,
        reason: "seed",
        parameters: {},
      }),
      now: NOW,
    });
  }
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: taskId,
      listId: "901616314492",
      status: "ready_for_release",
      managed: true,
      operationRequest: null,
      operationRequestId: null,
      targetVersion: "version-1",
      platforms,
      assignee: null,
      updatedAt: NOW,
      fieldsHash: "hash",
    },
    readAt: NOW,
  });
}

async function prepareVersion(harness, { platforms = ["web"], iosApps = [] } = {}) {
  await seedVersion(harness, "version-1");
  await seedTaskToRelease(harness, "task-a", platforms);
  const frozen = await freezeManifest({
    db: harness.db,
    versionId: "version-1",
    now: NOW,
    runtimeReadiness: { ready: true, configuredTargets: ["web", "api", "ios", "mini_program"] },
    versionBranch: "version/version-1",
    candidateCommit: CANDIDATE_COMMIT,
    candidateRef: `refs/heads/release-candidate/version-1/${CANDIDATE_COMMIT}`,
    taskPrHeads: [{
      taskId: "task-a",
      branch: "task/task-a",
      headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      prNumber: 42,
      repository: "owner/repo",
    }],
    artifactIdentity: ARTIFACT_IDENTITY,
    regressionEvidence: {
      passed: true,
      command: "node --test test/orchestration/*.test.mjs",
      collectedAt: NOW,
    },
    productionTargetPlan: {
      schemaVersion: 1,
      taskPlatforms: [{ taskId: "task-a", platforms }],
      platforms: {
        web: platforms.includes("web"),
        api: platforms.includes("api"),
        ios: platforms.includes("ios"),
      },
      iosApps: iosApps.map(({ enabled, ...app }) => app),
    },
  });
  assert.equal(frozen.status, "frozen", frozen.reasons?.join("; "));
}

test("confirm release publishes the version and its tasks", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await prepareVersion(harness);
  const adapter = {
    release: async () => webSubmission(),
    readback: async () => webPublication(),
  };
  const result = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-1",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    now: NOW,
    adapter,
  });
  assert.equal(result.status, "succeeded");
  const version = await loadAggregate(harness.db, "version", "version-1");
  assert.equal(version.state, "published");
  const task = await loadAggregate(harness.db, "task", "task-a");
  assert.equal(task.state, "published");
  assert.equal(result.publication.candidateCommit, CANDIDATE_COMMIT);
});

test("an iOS review wait keeps the version releasing and publishes nothing until every target is live", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const app = {
    id: "au",
    name: "Overseas",
    enabled: true,
    scheme: "E365AU",
    testScheme: "E365AUTests",
    testTarget: "E365AUTests",
    appStoreAppId: "0000000001",
    bundleId: "online.365english.app",
    testFlightGroup: "Internal Testing",
    buildNumberSource: "app-store-connect",
    releaseMode: "automatic",
    reviewConfigurationRef: "app-store-review/au",
    marketingVersion: "1.2.3",
  };
  await prepareVersion(harness, { platforms: ["ios"], iosApps: [app] });
  let waiting = true;
  const iosCalls = [];
  const options = {
    db: harness.db,
    versionId: "version-1",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    adapter: {
      release: async () => webSubmission(),
      readback: async () => webPublication(),
    },
    apps: [app],
    iosAdapter: {
      release: async ({ recordStage }) => {
        iosCalls.push("release");
        await recordStage("test");
        await recordStage("archive");
        await recordStage("upload", { buildNumber: "101", uploadId: "au-upload-1" });
        await recordStage("processing", {
          buildNumber: "101", processingStatus: "processed", processingId: "au-processing-1",
        });
        await recordStage("review_submit", {
          buildNumber: "101", reviewStatus: "submitted", reviewSubmissionId: "au-submission-1",
        });
        await recordStage("review_wait", { buildNumber: "101" });
        return {
          externalRequestId: "au-request-1",
          buildNumber: "101",
          uploadId: "au-upload-1",
          processingStatus: "processed",
          processingId: "au-processing-1",
          reviewStatus: "submitted",
          reviewSubmissionId: "au-submission-1",
          releaseStatus: "not_released",
          liveStatus: "not_live",
          observedEvidence: { build: "101" },
          lineage: {
            externalRequestId: "au-request-1",
            buildNumber: "101",
            uploadId: "au-upload-1",
            processingId: "au-processing-1",
            reviewSubmissionId: "au-submission-1",
          },
        };
      },
      readback: async ({ recordStage }) => {
        iosCalls.push("readback");
        await recordStage("live_readback", { buildNumber: "101" });
        if (waiting) return {
          status: "waiting_external", authoritative: true, submissionExists: true,
          reviewStatus: "submitted",
          lineage: {
            externalRequestId: "au-request-1", buildNumber: "101", uploadId: "au-upload-1",
            processingId: "au-processing-1", reviewSubmissionId: "au-submission-1",
          },
        };
        return {
          status: "completed",
          authoritative: true,
          externalRequestId: "au-request-1",
          buildNumber: "101",
          uploadId: "au-upload-1",
          processingStatus: "processed",
          processingId: "au-processing-1",
          reviewStatus: "approved",
          reviewSubmissionId: "au-submission-1",
          reviewId: "au-review-1",
          releaseStatus: "released",
          releaseId: "au-release-1",
          liveStatus: "live",
          liveId: "au-live-1",
          liveMarketingVersion: "1.2.3",
          liveBuildNumber: "101",
          liveMembershipConfirmed: true,
          observedEvidence: { build: "101" },
          liveEvidence: {
            membershipConfirmed: true, appStoreAppId: "0000000001",
            marketingVersion: "1.2.3", buildNumber: "101", liveId: "au-live-1",
          },
          lineage: {
            externalRequestId: "au-request-1",
            buildNumber: "101",
            uploadId: "au-upload-1",
            processingId: "au-processing-1",
            reviewSubmissionId: "au-submission-1",
            reviewId: "au-review-1",
            releaseId: "au-release-1",
            liveId: "au-live-1",
          },
        };
      },
    },
  };

  const first = await handleConfirmRelease({ ...options, now: NOW });
  assert.equal(first.status, "waiting_external", first.error);
  assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "releasing");
  assert.equal((await loadAggregate(harness.db, "task", "task-a")).state, "ready_for_release");

  waiting = false;
  const second = await handleConfirmRelease({ ...options, now: "2026-08-04T00:08:00.000Z" });
  assert.equal(second.status, "succeeded");
  assert.deepEqual(iosCalls, ["release", "readback", "readback"]);
  assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "published");
  assert.equal((await loadAggregate(harness.db, "task", "task-a")).state, "published");
  assert.equal(second.publication.kind, "ios_aggregate");
  assert.equal(second.publication.candidateCommit, CANDIDATE_COMMIT);
  assert.match(second.publication.cleanupToken, /^ios:/);
});

test("confirm release rejects missing or placeholder deployers before state changes", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await prepareVersion(harness);

  for (const adapter of [null, { placeholder: true, release: async () => ({}) }]) {
    const result = await handleConfirmRelease({
      db: harness.db,
      versionId: "version-1",
      actorId: "release-manager",
      actorRoles: ["release_manager"],
      now: NOW,
      adapter,
    });
    assert.equal(result.status, "rejected");
    assert.match(result.error, /deployer|adapter/i);
    const version = await loadAggregate(harness.db, "version", "version-1");
    assert.equal(version.state, "active");
  }
});

test("confirm release fails without exact remote Candidate readback and preserves tasks", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await prepareVersion(harness);

  const result = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-1",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    now: NOW,
    adapter: {
      release: async () => webSubmission(),
      readback: async () => webPublication("2222222222222222222222222222222222222222"),
    },
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /Candidate readback/i);
  assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "release_failed");
  assert.equal((await loadAggregate(harness.db, "task", "task-a")).state, "ready_for_release");
});

test("confirm release rejects Candidate mutations from every web deployer stage", async (t) => {
  const tamperedCommit = "2222222222222222222222222222222222222222";
  const tamperedArtifactIdentity = {
    digest: "sha256:tampered-artifact",
    object: "releases/version-1/sha256:tampered-artifact",
  };

  for (const mutationStage of ["preflight", "upload", "switchEntry"]) {
    await t.test(mutationStage, async (t) => {
      const harness = await createCloudWorkerHarness();
      t.after(() => harness.dispose());
      await prepareVersion(harness);
      const frozenBefore = await harness.db
        .prepare("SELECT manifest, created_at FROM release_manifests WHERE version_id = ?")
        .bind("version-1")
        .first();
      let publishedState = null;

      const attemptMutation = (stage, mutate) => {
        if (mutationStage !== stage) return;
        try {
          mutate();
        } catch {
          // A frozen release snapshot rejects the deployer's mutation attempt.
        }
      };
      const deployer = {
        preflight: async ({ manifest }) => {
          attemptMutation("preflight", () => {
            manifest.candidateCommit = tamperedCommit;
          });
          attemptMutation("preflight", () => {
            manifest.artifactIdentity.digest = tamperedArtifactIdentity.digest;
          });
          attemptMutation("preflight", () => {
            manifest.artifactIdentity.object = tamperedArtifactIdentity.object;
          });
          attemptMutation("preflight", () => {
            manifest.taskPrHeads[0].headCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
          });
          return { ok: true };
        },
        upload: async ({ versionId, candidateCommit, artifactIdentity }) => {
          attemptMutation("upload", () => {
            artifactIdentity.digest = tamperedArtifactIdentity.digest;
          });
          attemptMutation("upload", () => {
            artifactIdentity.object = tamperedArtifactIdentity.object;
          });
          return {
            object: `releases/${versionId}/${artifactIdentity.digest}/index.html`,
            candidateCommit,
            artifactIdentity,
            externalRequestId: "web-request-1",
          };
        },
        switchEntry: async ({ candidateCommit, artifactIdentity }) => {
          attemptMutation("switchEntry", () => {
            artifactIdentity.digest = tamperedArtifactIdentity.digest;
          });
          attemptMutation("switchEntry", () => {
            artifactIdentity.object = tamperedArtifactIdentity.object;
          });
          publishedState = {
            confirmed: true,
            published: true,
            status: "published",
            authoritative: true,
            candidateCommit: mutationStage === "preflight" ? tamperedCommit : CANDIDATE_COMMIT,
            artifactIdentity: structuredClone(tamperedArtifactIdentity),
            url: "https://releases.example.com/v1",
            externalRequestId: "web-request-1",
            productionReleaseId: "web-release-1",
            healthStatus: "healthy",
            evidence: { source: "production-readback" },
          };
          return { url: publishedState.url, productionReleaseId: "web-release-1" };
        },
        healthCheck: async () => ({ ok: true, status: 200 }),
        readback: async () => structuredClone(publishedState),
      };

      const result = await handleConfirmRelease({
        db: harness.db,
        versionId: "version-1",
        actorId: "release-manager",
        actorRoles: ["release_manager"],
        now: NOW,
        adapter: createWebAdapter({ deployer }),
      });

      assert.equal(result.status, "failed");
      assert.match(result.error, /Candidate readback/i);
      assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "release_failed");
      assert.equal((await loadAggregate(harness.db, "task", "task-a")).state, "ready_for_release");
      const frozenAfter = await harness.db
        .prepare("SELECT manifest, created_at FROM release_manifests WHERE version_id = ?")
        .bind("version-1")
        .first();
      assert.deepEqual(frozenAfter, frozenBefore);
    });
  }
});

test("confirm release rejects missing manifests", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedVersion(harness, "version-2");
  const result = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-2",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    now: NOW,
    adapter: { release: async () => ({}) },
  });
  assert.equal(result.status, "rejected");
  assert.match(result.error, /manifest/i);
});

test("confirm release failure leaves tasks ready for release", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await prepareVersion(harness);
  const adapter = {
    release: async () => { throw deterministicReleaseError("deploy failed"); },
    readback: async () => {
      throw new Error("readback must not run after deployment failure");
    },
  };
  const result = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-1",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    now: NOW,
    adapter,
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /deploy failed/);
  const version = await loadAggregate(harness.db, "version", "version-1");
  assert.equal(version.state, "release_failed");
  const task = await loadAggregate(harness.db, "task", "task-a");
  assert.equal(task.state, "ready_for_release");
});

test("release_failed retries the existing immutable Candidate without recomputing it", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await prepareVersion(harness);
  const frozenBefore = await harness.db
    .prepare("SELECT manifest, created_at FROM release_manifests WHERE version_id = ?")
    .bind("version-1")
    .first();

  const first = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-1",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    now: NOW,
    adapter: {
      release: async () => { throw deterministicReleaseError("first deployment failed"); },
      readback: async () => { throw new Error("unreachable"); },
    },
  });
  assert.equal(first.status, "failed");
  assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "release_failed");

  let deployedManifest;
  const second = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-1",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    now: "2026-08-04T00:08:00.000Z",
    adapter: {
      release: async ({ manifest }) => {
        deployedManifest = manifest;
        return webSubmission();
      },
      readback: async () => webPublication(),
    },
  });

  assert.equal(second.status, "succeeded");
  assert.equal(deployedManifest.candidateCommit, CANDIDATE_COMMIT);
  assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "published");
  const frozenAfter = await harness.db
    .prepare("SELECT manifest, created_at FROM release_manifests WHERE version_id = ?")
    .bind("version-1")
    .first();
  assert.deepEqual(frozenAfter, frozenBefore);
});

test("partial task publication retries remaining tasks before publishing the version", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedVersion(harness, "version-1");
  await seedTaskToRelease(harness, "task-a");
  await seedTaskToRelease(harness, "task-b");
  await freezeManifest({
    db: harness.db,
    versionId: "version-1",
    now: NOW,
    runtimeReadiness: { ready: true, configuredTargets: ["web", "api", "ios", "mini_program"] },
    versionBranch: "version/version-1",
    candidateCommit: CANDIDATE_COMMIT,
    candidateRef: `refs/heads/release-candidate/version-1/${CANDIDATE_COMMIT}`,
    taskPrHeads: [
      {
        taskId: "task-a",
        branch: "remote-task-a",
        headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        prNumber: 41,
        repository: "owner/repo",
      },
      {
        taskId: "task-b",
        branch: "remote-task-b",
        headCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        prNumber: 42,
        repository: "owner/repo",
      },
    ],
    artifactIdentity: ARTIFACT_IDENTITY,
    regressionEvidence: { passed: true, command: "node --test", collectedAt: NOW },
    productionTargetPlan: {
      schemaVersion: 1,
      taskPlatforms: [
        { taskId: "task-a", platforms: ["web"] },
        { taskId: "task-b", platforms: ["web"] },
      ],
      platforms: { web: true, api: false, ios: false },
      iosApps: [],
    },
  });
  const adapter = {
    release: async () => webSubmission(),
    readback: async () => webPublication(),
  };
  let failTaskB = true;
  const published = [];
  const dispatch = async (input) => {
    if (input.command.type === "publish_task") {
      published.push(input.command.aggregateId);
      if (input.command.aggregateId === "task-b" && failTaskB) {
        throw new Error("task-b publish failed");
      }
    }
    return dispatchCommand(input);
  };

  const first = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-1",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    now: NOW,
    adapter,
    dispatch,
  });
  assert.equal(first.status, "failed");
  assert.match(first.error, /task-b publish failed/);
  assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "release_failed");
  assert.equal((await loadAggregate(harness.db, "task", "task-a")).state, "published");
  assert.equal((await loadAggregate(harness.db, "task", "task-b")).state, "ready_for_release");

  failTaskB = false;
  const second = await handleConfirmRelease({
    db: harness.db,
    versionId: "version-1",
    actorId: "release-manager",
    actorRoles: ["release_manager"],
    now: "2026-08-04T00:09:00.000Z",
    adapter,
    dispatch,
  });
  assert.equal(second.status, "succeeded");
  assert.equal((await loadAggregate(harness.db, "version", "version-1")).state, "published");
  assert.equal((await loadAggregate(harness.db, "task", "task-b")).state, "published");
  assert.equal(published.filter((taskId) => taskId === "task-a").length, 1);
  assert.equal(published.filter((taskId) => taskId === "task-b").length, 2);
});

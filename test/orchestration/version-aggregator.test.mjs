import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { createDomainEvent } from "../../orchestration/domain/events.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { appendCommandResult } from "../../orchestration/persistence/d1-event-store.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { saveSnapshot } from "../../orchestration/clickup/snapshot.mjs";
import {
  checkVersionGate,
  freezeManifest,
  loadManifest,
  validateFrozenManifest,
} from "../../orchestration/release/version-aggregator.mjs";
import { assertProductionTargetPlanMatches } from "../../orchestration/release/production-target-plan.mjs";
import { buildProductionTargetPlan } from "../../orchestration/release/production-target-plan.mjs";

const NOW = "2026-08-04T00:06:00.000Z";
const RUNTIME_TARGETS = Object.freeze({
  runtimeReadiness: { ready: true, configuredTargets: ["web", "api", "ios", "mini_program"] },
});
const CANDIDATE = {
  versionBranch: "version/version-1",
  candidateCommit: "1111111111111111111111111111111111111111",
  candidateRef: "refs/heads/release-candidate/version-1/1111111111111111111111111111111111111111",
  taskPrHeads: [
    {
      taskId: "task-a",
      branch: "task/task-a",
      headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      prNumber: 41,
      repository: "owner/repo",
    },
    {
      taskId: "task-b",
      branch: "task/task-b",
      headCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      prNumber: 42,
      repository: "owner/repo",
    },
  ],
  artifactIdentity: {
    digest: "sha256:artifact-v1",
    object: "releases/version-1/sha256:artifact-v1",
  },
  regressionEvidence: {
    passed: true,
    command: "node --test test/orchestration/*.test.mjs",
    collectedAt: NOW,
  },
  productionTargetPlan: {
    schemaVersion: 1,
    taskPlatforms: [
      { taskId: "task-a", platforms: ["web"] },
      { taskId: "task-b", platforms: ["web"] },
    ],
    platforms: { web: true, api: false, ios: false },
    iosApps: [],
  },
};

async function seedActiveVersion(harness, versionId = "version-1") {
  const event = await createDomainEvent({
    id: `seed-${versionId}`,
    sequence: 1,
    aggregateType: "version",
    aggregateId: versionId,
    aggregateVersion: 1,
    type: "version.activated",
    commandId: `seed-cmd-${versionId}`,
    actorId: "system",
    occurredAt: NOW,
    data: { from: "planning", to: "active" },
    previousHash: null,
  });
  await appendCommandResult(harness.db, {
    command: parseCommandEnvelope({
      id: `seed-cmd-${versionId}`,
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

async function seedTaskSnapshot(harness, taskId, status, targetVersion, platforms = ["web"]) {
  await saveSnapshot(harness.db, {
    type: "task",
    snapshot: {
      id: taskId,
      listId: "901616314492",
      status,
      managed: true,
      operationRequest: null,
      operationRequestId: null,
      targetVersion,
      platforms,
      assignee: null,
      updatedAt: NOW,
      fieldsHash: "hash",
    },
    readAt: NOW,
  });
}

test("version gate fails with no tasks", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  const gate = await checkVersionGate({ db: harness.db, versionId: "version-1", ...RUNTIME_TARGETS });
  assert.equal(gate.pass, false);
  assert.ok(gate.reasons.some((reason) => reason.includes("no tasks")));
});

test("version gate fails when a task is not ready for release", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  await seedTaskSnapshot(harness, "task-a", "developing", "version-1");
  await seedTaskSnapshot(harness, "task-b", "ready_for_release", "version-1");
  const gate = await checkVersionGate({ db: harness.db, versionId: "version-1", ...RUNTIME_TARGETS });
  assert.equal(gate.pass, false);
  assert.ok(gate.reasons.some((reason) => reason.includes("task-a")));
});

test("version gate excludes canceled tasks before the Manifest is frozen", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  await seedTaskSnapshot(harness, "task-ready", "ready_for_release", "version-1");
  await seedTaskSnapshot(harness, "task-canceled", "canceled", "version-1");

  const gate = await checkVersionGate({ db: harness.db, versionId: "version-1", ...RUNTIME_TARGETS });
  assert.equal(gate.pass, true);
  assert.deepEqual(gate.taskIds, ["task-ready"]);
});

test("version gate resolves structured platform evidence and accepts configured mini-program", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  await seedTaskSnapshot(harness, "task-a", "ready_for_release", "version-1");
  const row = await harness.db.prepare("SELECT snapshot FROM clickup_snapshots WHERE object_id = 'task-a'").first();
  const snapshot = JSON.parse(row.snapshot);
  snapshot.platforms = [];
  await harness.db.prepare("UPDATE clickup_snapshots SET snapshot = ? WHERE object_id = 'task-a'").bind(JSON.stringify(snapshot)).run();
  await harness.db.prepare(`INSERT INTO runner_jobs
    (id,command_id,job_type,payload,payload_hash,status,result,created_at,completed_at)
    VALUES ('task-a-develop-1','development-task-a-develop-1','develop',?,'hash','completed',?,?,?)`)
    .bind(JSON.stringify({ taskId: "task-a" }), JSON.stringify({ status: "completed", platforms: ["服务端", "小程序"] }), NOW, NOW).run();

  const gate = await checkVersionGate({ db: harness.db, versionId: "version-1", ...RUNTIME_TARGETS });
  assert.equal(gate.pass, true);
  assert.deepEqual(gate.taskIds, ["task-a"]);
  assert.deepEqual(gate.taskPlatforms, [{
    taskId: "task-a", platforms: ["api", "mini_program"], source: "develop_job",
    evidenceId: "task-a-develop-1", commitSha: null, acceptedCommitSha: null, aggregateVersion: null, androidDelivery: null,
  }]);
  assert.equal(gate.reasons.some((reason) => reason.includes("mini_program")), false);
});

test("version gate fails closed when runtime does not explicitly configure the Candidate target", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  await seedTaskSnapshot(harness, "task-mp", "ready_for_release", "version-1", ["mini_program"]);

  const gate = await checkVersionGate({
    db: harness.db, versionId: "version-1",
    runtimeReadiness: { ready: true, configuredTargets: ["web", "api", "ios"] },
  });

  assert.equal(gate.pass, false);
  assert.ok(gate.reasons.includes("production target is not configured: mini_program"));
});

test("version gate fails when a task is blocked", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  await seedTaskSnapshot(harness, "task-a", "ready_for_release", "version-1");
  await harness.db
    .prepare(
      `INSERT INTO blockers (id, object_type, object_id, type, reason, status, created_at)
       VALUES (?, 'task', ?, 'rework_budget', ?, 'open', ?)`,
    )
    .bind("block-task-a", "task-a", "exhausted", NOW)
    .run();
  const gate = await checkVersionGate({ db: harness.db, versionId: "version-1", ...RUNTIME_TARGETS });
  assert.equal(gate.pass, false);
  assert.ok(gate.reasons.some((reason) => reason.includes("blocked")));
});

test("freezeManifest records the exact immutable Candidate without advancing version state", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  await seedTaskSnapshot(harness, "task-a", "ready_for_release", "version-1");
  await seedTaskSnapshot(harness, "task-b", "ready_for_release", "version-1");
  const result = await freezeManifest({
    db: harness.db,
    versionId: "version-1",
    now: NOW,
    ...RUNTIME_TARGETS,
    ...CANDIDATE,
  });
  assert.equal(result.status, "frozen");
  assert.deepEqual(result.manifest.taskIds.sort(), ["task-a", "task-b"]);
  assert.equal(result.manifest.versionBranch, CANDIDATE.versionBranch);
  assert.equal(result.manifest.candidateCommit, CANDIDATE.candidateCommit);
  assert.equal(result.manifest.candidateRef, CANDIDATE.candidateRef);
  assert.deepEqual(result.manifest.taskPrHeads, CANDIDATE.taskPrHeads);
  assert.deepEqual(result.manifest.artifactIdentity, CANDIDATE.artifactIdentity);
  assert.deepEqual(result.manifest.regressionEvidence, CANDIDATE.regressionEvidence);
  assert.deepEqual(result.manifest.productionTargetPlan, CANDIDATE.productionTargetPlan);
  assert.equal(typeof result.manifest.checksum, "string");
  const tamperedPlan = structuredClone(result.manifest);
  tamperedPlan.productionTargetPlan.platforms.api = true;
  assert.ok(validateFrozenManifest(tamperedPlan).some((reason) => /checksum/i.test(reason)));
  const aggregate = await loadAggregate(harness.db, "version", "version-1");
  assert.equal(aggregate.state, "active");
  const stored = await loadManifest({ db: harness.db, versionId: "version-1" });
  assert.deepEqual(stored, result.manifest);

  const changedCandidate = await freezeManifest({
    db: harness.db,
    versionId: "version-1",
    now: "2026-08-04T00:10:00.000Z",
    ...RUNTIME_TARGETS,
    ...CANDIDATE,
    candidateCommit: "2222222222222222222222222222222222222222",
  });
  assert.equal(changedCandidate.status, "already_frozen");
  assert.deepEqual(changedCandidate.manifest, result.manifest);
});

test("freezeManifest rejects Candidate metadata gaps", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  await seedTaskSnapshot(harness, "task-a", "ready_for_release", "version-1");

  const result = await freezeManifest({
    db: harness.db,
    versionId: "version-1",
    now: NOW,
    ...RUNTIME_TARGETS,
    versionBranch: "version/version-1",
    candidateCommit: CANDIDATE.candidateCommit,
    taskPrHeads: [],
    artifactIdentity: CANDIDATE.artifactIdentity,
    regressionEvidence: { passed: false },
  });

  assert.equal(result.status, "rejected");
  assert.ok(result.reasons.some((reason) => /task PR heads/i.test(reason)));
  assert.ok(result.reasons.some((reason) => /regression evidence/i.test(reason)));
  assert.equal(await loadManifest({ db: harness.db, versionId: "version-1" }), null);
});

test("freezeManifest refuses when the gate fails", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedActiveVersion(harness);
  const result = await freezeManifest({ db: harness.db, versionId: "version-1", now: NOW, ...RUNTIME_TARGETS });
  assert.equal(result.status, "rejected");
});

test("frozen target plan rejects additions, removals, reordering, and tuple drift", () => {
  const plan = {
    schemaVersion: 1,
    taskPlatforms: [{ taskId: "task-a", platforms: ["web", "ios"] }],
    platforms: { web: true, api: false, ios: true },
    iosApps: [
      { id: "au", appStoreAppId: "1" },
      { id: "cn", appStoreAppId: "2" },
    ],
  };
  const variants = [
    { ...structuredClone(plan), iosApps: [plan.iosApps[0]] },
    { ...structuredClone(plan), iosApps: [...plan.iosApps, { id: "nz", appStoreAppId: "3" }] },
    { ...structuredClone(plan), iosApps: [...plan.iosApps].reverse() },
    {
      ...structuredClone(plan),
      iosApps: [{ ...plan.iosApps[0], appStoreAppId: "changed" }, plan.iosApps[1]],
    },
  ];
  for (const variant of variants) {
    assert.throws(
      () => assertProductionTargetPlanMatches(plan, variant),
      /target plan.*drift/i,
    );
  }
});

test("production target plan freezes exact Candidate paths, per-task evidence, apps, Android TWA, and DAG", () => {
  const miniProgramApps = [{
    id: "wechat", name: "365生活口语微信小程序", enabled: true,
    appId: "wx1fdac5e27c6b5366", sourceDirectory: "apps/mp",
    buildCommand: ["npm", "run", "build:mp-weixin"], artifactDirectory: "dist/build/mp-weixin",
    uploadCommand: ["node", "scripts/upload-wechat-mini-program.mjs"],
    reviewCommand: ["node", "scripts/submit-wechat-mini-program-review.mjs"],
    releaseCommand: ["node", "scripts/release-wechat-mini-program.mjs"],
    readbackCommand: ["node", "scripts/readback-wechat-mini-program.mjs"],
    credentialsPath: "private/wechat-mini-program.private.json",
    reviewConfigurationRef: "wechat-mini-program-review/primary",
  }];
  const candidateScope = {
    baseCommit: "a".repeat(40), candidateCommit: CANDIDATE.candidateCommit,
    mappingVersion: 1,
    changedPaths: ["apps/android-web-wrapper/manifest.json", "apps/mp/app.ts"],
    platforms: ["android_twa", "mini_program"], unsupported: [],
  };
  const taskEvidence = [{
    id: "task-a", platforms: ["android_twa", "mini_program"], source: "accepted_pr_changes",
    evidenceId: "accept-task-a", commitSha: "b".repeat(40), acceptedCommitSha: "b".repeat(40),
    aggregateVersion: 7, androidDelivery: "web_twa",
  }];

  const plan = buildProductionTargetPlan({
    taskSnapshots: taskEvidence, taskIds: ["task-a"], apps: [], miniProgramApps,
    marketingVersion: "1.2.3", candidateScope, plannedTargets: ["mini_program", "web"],
  });

  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.mappingVersion, 1);
  assert.deepEqual(plan.candidateScope, candidateScope);
  assert.deepEqual(plan.taskPlatforms, [{
    taskId: "task-a", platforms: ["android_twa", "mini_program"], source: "accepted_pr_changes",
    evidenceId: "accept-task-a", commitSha: "b".repeat(40), acceptedCommitSha: "b".repeat(40),
    aggregateVersion: 7, androidDelivery: "web_twa",
  }]);
  assert.deepEqual(plan.miniProgramApps, miniProgramApps.map(({ enabled, ...entry }) => ({
    ...entry,
    version: "1.2.3",
    versionSource: "release_snapshot_name",
    description: `Candidate ${CANDIDATE.candidateCommit}`,
  })));
  assert.deepEqual(plan.androidTwa, {
    enabled: true,
    sourceDirectory: "apps/android-web-wrapper/",
    dependsOn: "web",
  });
  assert.deepEqual(plan.platforms, {
    web: true, api: false, ios: false, mini_program: true, android_twa: true,
  });
  assert.deepEqual(plan.dag, {
    nodes: [
      { id: "web", platform: "web", appId: "", successCondition: "authoritative_readback", readbackIdentity: { candidateCommit: CANDIDATE.candidateCommit } },
      { id: "mini_program:wechat", platform: "mini_program", appId: "wechat", successCondition: "authoritative_live_readback", readbackIdentity: { appId: "wx1fdac5e27c6b5366", version: "1.2.3" } },
      { id: "android_twa", platform: "android_twa", appId: "", successCondition: "authoritative_live_readback", readbackIdentity: { candidateCommit: CANDIDATE.candidateCommit } },
    ],
    edges: [{ from: "web", to: "android_twa" }],
  });
});

test("canonical planned targets retain Candidate supplemental mini-program work for a Web task", () => {
  const candidateScope = {
    baseCommit: "a".repeat(40), candidateCommit: CANDIDATE.candidateCommit, mappingVersion: 1,
    changedPaths: ["apps/mp/app.ts"], platforms: ["mini_program"], unsupported: [],
  };
  const miniProgramApps = [{
    id: "wechat", name: "Wechat", enabled: true, appId: "wx1fdac5e27c6b5366",
    sourceDirectory: "apps/mp", buildCommand: ["npm", "run", "build:mp-weixin"],
    artifactDirectory: "dist/build/mp-weixin", uploadCommand: ["node", "upload.mjs"],
    reviewCommand: ["node", "review.mjs"], releaseCommand: ["node", "release.mjs"],
    readbackCommand: ["node", "readback.mjs"], credentialsPath: "private/wechat.private.json",
    reviewConfigurationRef: "review/wechat",
  }];
  const plan = buildProductionTargetPlan({
    taskSnapshots: [{ id: "task-web", platforms: ["web"] }], taskIds: ["task-web"],
    apps: [], miniProgramApps, marketingVersion: "2.0.0", candidateScope,
    plannedTargets: ["mini_program", "web"],
  });

  assert.deepEqual(plan.plannedTargets, ["mini_program", "web"]);
  assert.equal(plan.platforms.mini_program, true);
  assert.ok(plan.dag.nodes.some(({ id }) => id === "mini_program:wechat"));
  assert.equal(plan.miniProgramApps[0].appId, "wx1fdac5e27c6b5366");
});

function schema2ManifestForPlannedTargetValidation({ plan, eligibilityPlannedTargets }) {
  return {
    versionId: "version-planned-targets",
    versionBranch: "version/planned-targets",
    candidateCommit: "1".repeat(40),
    candidateRef: `refs/heads/release-candidate/planned-targets/${"1".repeat(40)}`,
    taskIds: ["task-web"],
    taskPrHeads: [{
      taskId: "task-web", branch: "task/task-web", headCommit: "2".repeat(40),
      prNumber: 42, repository: "owner/repo",
    }],
    artifactIdentity: { digest: "sha256:artifact" },
    regressionEvidence: { passed: true },
    releaseEligibility: { plannedTargets: eligibilityPlannedTargets },
    productionTargetPlan: plan,
  };
}

test("frozen Manifest rejects a plan that drops Candidate supplemental mini-program eligibility", () => {
  const candidateScope = {
    baseCommit: "0".repeat(40), candidateCommit: "1".repeat(40), mappingVersion: 1,
    changedPaths: ["apps/mp/app.ts", "apps/web/index.ts"],
    platforms: ["mini_program", "web"], unsupported: [],
  };
  const plan = buildProductionTargetPlan({
    taskSnapshots: [{ id: "task-web", platforms: ["web"] }], taskIds: ["task-web"],
    candidateScope, plannedTargets: ["web"], apps: [], miniProgramApps: [],
  });

  assert.ok(validateFrozenManifest(schema2ManifestForPlannedTargetValidation({
    plan,
    eligibilityPlannedTargets: ["web", "mini_program"],
  })).some((reason) => /planned targets.*eligibility|eligibility.*planned targets/i.test(reason)));
});

test("frozen Manifest rejects an unexplained mini-program plan target absent from canonical eligibility", () => {
  const candidateScope = {
    baseCommit: "0".repeat(40), candidateCommit: "1".repeat(40), mappingVersion: 1,
    changedPaths: ["apps/web/index.ts"], platforms: ["web"], unsupported: [],
  };
  const miniProgramApps = [{
    id: "wechat", name: "Wechat", enabled: true, appId: "wx1fdac5e27c6b5366",
    sourceDirectory: "apps/mp", buildCommand: ["npm", "run", "build:mp-weixin"],
    artifactDirectory: "dist/build/mp-weixin", uploadCommand: ["node", "upload.mjs"],
    reviewCommand: ["node", "review.mjs"], releaseCommand: ["node", "release.mjs"],
    readbackCommand: ["node", "readback.mjs"], credentialsPath: "private/wechat.private.json",
    reviewConfigurationRef: "review/wechat",
  }];
  const plan = buildProductionTargetPlan({
    taskSnapshots: [{ id: "task-web", platforms: ["web"] }], taskIds: ["task-web"],
    candidateScope, plannedTargets: ["mini_program", "web"], apps: [], miniProgramApps,
    marketingVersion: "2.0.0",
  });

  assert.ok(validateFrozenManifest(schema2ManifestForPlannedTargetValidation({
    plan,
    eligibilityPlannedTargets: ["web"],
  })).some((reason) => /planned targets.*eligibility|eligibility.*planned targets/i.test(reason)));
});

test("Manifest checksum covers Candidate paths, mapping, App descriptors, and DAG", async (t) => {
  async function freezeWith(mutator) {
    const harness = await createCloudWorkerHarness();
    t.after(() => harness.dispose());
    await seedActiveVersion(harness);
    await seedTaskSnapshot(harness, "task-a", "ready_for_release", "version-1", ["mini_program"]);
    const candidateScope = {
      baseCommit: "a".repeat(40), candidateCommit: CANDIDATE.candidateCommit, mappingVersion: 1,
      changedPaths: ["apps/mp/app.ts"], platforms: ["mini_program"], unsupported: [],
    };
    const miniProgramApps = [{
      id: "wechat", name: "365生活口语微信小程序", enabled: true,
      appId: "wx1fdac5e27c6b5366", sourceDirectory: "apps/mp",
      buildCommand: ["npm", "run", "build:mp-weixin"], artifactDirectory: "dist/build/mp-weixin",
      uploadCommand: ["node", "upload.mjs"], reviewCommand: ["node", "review.mjs"],
      releaseCommand: ["node", "release.mjs"], readbackCommand: ["node", "readback.mjs"],
      credentialsPath: "private/wechat.private.json", reviewConfigurationRef: "review/wechat",
    }];
    const taskSnapshots = [{ id: "task-a", platforms: ["mini_program"] }];
    const plannedTargets = ["mini_program"];
    const releaseIdentity = { marketingVersion: "1.2.3" };
    mutator({ candidateScope, miniProgramApps, taskSnapshots, plannedTargets, releaseIdentity });
    const plan = buildProductionTargetPlan({
      taskSnapshots, taskIds: ["task-a"], apps: [], miniProgramApps, candidateScope,
      marketingVersion: releaseIdentity.marketingVersion, plannedTargets: plannedTargets.sort(),
    });
    const result = await freezeManifest({
      db: harness.db, versionId: "version-1", now: NOW,
      runtimeReadiness: { ready: true, configuredTargets: ["mini_program"] },
      versionBranch: CANDIDATE.versionBranch, candidateCommit: CANDIDATE.candidateCommit,
      candidateRef: CANDIDATE.candidateRef, taskPrHeads: [CANDIDATE.taskPrHeads[0]],
      artifactIdentity: CANDIDATE.artifactIdentity, regressionEvidence: CANDIDATE.regressionEvidence,
      candidateScope: plan.candidateScope, productionTargetPlan: plan,
    });
    assert.equal(result.status, "frozen", result.reasons?.join("; "));
    return result.manifest.checksum;
  }

  const baseline = await freezeWith(() => {});
  const variants = [
    await freezeWith(({ candidateScope }) => { candidateScope.changedPaths[0] = "apps/mp/other.ts"; }),
    await freezeWith(({ candidateScope }) => { candidateScope.mappingVersion = 2; }),
    await freezeWith(({ miniProgramApps }) => { miniProgramApps[0].appId = "wx0000000000000000"; }),
    await freezeWith(({ releaseIdentity }) => { releaseIdentity.marketingVersion = "1.2.4"; }),
    await freezeWith(({ candidateScope, plannedTargets }) => {
      candidateScope.platforms.push("web");
      candidateScope.changedPaths.push("apps/web/index.ts");
      plannedTargets.push("web");
    }),
    await freezeWith(({ candidateScope, taskSnapshots, plannedTargets }) => {
      candidateScope.platforms.unshift("android_twa");
      candidateScope.changedPaths.unshift("apps/android-web-wrapper/manifest.json");
      taskSnapshots[0].platforms.unshift("android_twa");
      plannedTargets.push("web");
    }),
  ];
  assert.equal(new Set([baseline, ...variants]).size, variants.length + 1);
});

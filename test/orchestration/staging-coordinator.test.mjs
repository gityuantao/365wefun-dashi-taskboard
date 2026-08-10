import assert from "node:assert/strict";
import test from "node:test";

import { executeStagingGate } from "../../orchestration/application/staging-coordinator.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";

const NOW = "2026-08-10T08:00:00.000Z";
const CANDIDATE_COMMIT = "1111111111111111111111111111111111111111";
const TASK_COMMIT = "2222222222222222222222222222222222222222";
const IOS_APPS = [
  {
    id: "au",
    name: "海外版",
    enabled: true,
    scheme: "E365AU",
    bundleId: "online.365english.app",
    testFlightGroup: "Internal Testing AU",
    buildNumberSource: "app-store-connect",
  },
  {
    id: "cn",
    name: "中国版",
    enabled: true,
    scheme: "E365CN",
    bundleId: "online.365english.china",
    testFlightGroup: "Internal Testing CN",
    buildNumberSource: "app-store-connect",
  },
];

async function seedAcceptingTask(db, taskId) {
  for (const [index, type] of [
    "start_analysis",
    "analysis_completed",
    "start_development",
    "development_completed",
  ].entries()) {
    const result = await dispatchCommand({
      db,
      command: parseCommandEnvelope({
        id: `${taskId}-seed-${type}`,
        type,
        aggregateType: "task",
        aggregateId: taskId,
        expectedVersion: index + 1,
        actorId: "test",
        issuedAt: NOW,
        reason: "seed accepting task",
        parameters: {},
      }),
      now: NOW,
    });
    assert.equal(result.status, "succeeded");
  }
}

function stagingJob(taskId, platforms) {
  return {
    id: `${taskId}-stage-4`,
    payload: {
      taskId,
      platforms,
      pr: { url: "https://github.com/example/repo/pull/42" },
      commitSha: TASK_COMMIT,
      versionBranch: "version/1.2.3",
      targetVersion: "1.2.3",
    },
  };
}

function webGate() {
  return {
    gitOps: {
      integrateTaskPr: async () => ({
        merged: true,
        candidateCommit: CANDIDATE_COMMIT,
        taskHead: TASK_COMMIT,
        prNumber: 42,
      }),
      persistCandidate: async () => ({ persisted: true }),
    },
    adapter: {
      deploy: async () => ({ releaseId: "web-release-42", url: "https://test.example.com" }),
      readback: async () => ({
        confirmed: true,
        releaseId: "web-release-42",
        gitSha: CANDIDATE_COMMIT,
        urls: ["https://test.example.com"],
        deployedAt: NOW,
      }),
    },
  };
}

async function acceptancePassedCount(db, taskId) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM orchestration_events
     WHERE aggregate_type = 'task' AND aggregate_id = ? AND type = 'task.acceptance_passed'`,
  ).bind(taskId).first();
  return Number(row?.count ?? 0);
}

test("an iOS task advances exactly once only after Web and every TestFlight App succeed", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const taskId = "task-ios-success";
  await seedAcceptingTask(harness.db, taskId);
  const comments = [];
  const stagedApps = [];
  const { gitOps, adapter } = webGate();

  const result = await executeStagingGate({
    job: stagingJob(taskId, ["Web", "iOS"]),
    db: harness.db,
    client: { postComment: async (_taskId, body) => comments.push(body) },
    gitOps,
    adapter,
    iosApps: IOS_APPS,
    iosAdapter: {
      stage: async ({ app, targetVersion }) => {
        stagedApps.push(app.id);
        assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "accepting");
        assert.equal(await acceptancePassedCount(harness.db, taskId), 0);
        return {
          appId: app.id,
          scheme: app.scheme,
          bundleId: app.bundleId,
          marketingVersion: targetVersion,
          buildNumber: app.id === "au" ? "101" : "202",
          uploadId: `upload-${app.id}`,
        };
      },
      readback: async ({ app }) => ({
        processed: true,
        processingStatus: "processed",
        testGroup: app.testFlightGroup,
        membershipConfirmed: true,
        checkedAt: NOW,
      }),
    },
    now: NOW,
  });

  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(stagedApps, ["au", "cn"]);
  assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "ready_for_test");
  assert.equal(await acceptancePassedCount(harness.db, taskId), 1);
  const finalComment = comments.at(-1);
  assert.match(finalComment, /Web\/API.*web-release-42/);
  assert.match(finalComment, /TestFlight.*海外版.*build=101/);
  assert.match(finalComment, /TestFlight.*中国版.*build=202/);
});

test("a Web-only task never invokes the iOS adapter", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const taskId = "task-web-only";
  await seedAcceptingTask(harness.db, taskId);
  const { gitOps, adapter } = webGate();
  let iosCalls = 0;

  const result = await executeStagingGate({
    job: stagingJob(taskId, ["WEB", "api"]),
    db: harness.db,
    client: { postComment: async () => ({}) },
    gitOps,
    adapter,
    iosApps: IOS_APPS,
    iosAdapter: {
      stage: async () => { iosCalls += 1; throw new Error("must not stage iOS"); },
      readback: async () => { iosCalls += 1; throw new Error("must not read iOS"); },
    },
    now: NOW,
  });

  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(iosCalls, 0);
  assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "ready_for_test");
});

test("an iOS App failure uses its exact TestFlight App and stage in staging rollback", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const taskId = "task-ios-failure";
  await seedAcceptingTask(harness.db, taskId);
  const comments = [];
  const { gitOps, adapter } = webGate();

  const result = await executeStagingGate({
    job: stagingJob(taskId, "web、IoS"),
    db: harness.db,
    client: { postComment: async (_taskId, body) => comments.push(body) },
    gitOps,
    adapter,
    iosApps: IOS_APPS,
    iosAdapter: {
      stage: async ({ app, targetVersion }) => ({
        appId: app.id,
        scheme: app.scheme,
        bundleId: app.bundleId,
        marketingVersion: targetVersion,
        buildNumber: app.id === "au" ? "101" : "202",
        uploadId: `upload-${app.id}`,
      }),
      readback: async ({ app }) => app.id === "cn"
        ? {
            processed: false,
            processingStatus: "processing",
            testGroup: app.testFlightGroup,
            membershipConfirmed: false,
            checkedAt: NOW,
          }
        : {
            processed: true,
            processingStatus: "processed",
            testGroup: app.testFlightGroup,
            membershipConfirmed: true,
            checkedAt: NOW,
          },
    },
    now: NOW,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stage, "testflight:cn:processing");
  assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "ready_for_development");
  assert.equal(await acceptancePassedCount(harness.db, taskId), 0);
  assert.ok(comments.some((comment) => String(comment).includes("阶段：testflight:cn:processing")));
});

test("a reclaimed staging lease blocks the next iOS external operation and every later App", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const taskId = "task-ios-reclaimed-lease";
  await seedAcceptingTask(harness.db, taskId);
  const { gitOps, adapter } = webGate();
  let guardCalls = 0;
  let readbackCalls = 0;
  const stagedApps = [];

  const result = await executeStagingGate({
    job: stagingJob(taskId, ["ios"]),
    db: harness.db,
    client: { postComment: async () => ({}) },
    gitOps,
    adapter,
    iosApps: IOS_APPS,
    beforeExternalOperation: async () => { guardCalls += 1; },
    iosAdapter: {
      stage: async ({ app, targetVersion }) => {
        assert.equal(guardCalls, 1);
        stagedApps.push(app.id);
        await harness.db.prepare(
          "UPDATE orchestration_leases SET expires_at = ? WHERE id = 'staging-environment'",
        ).bind("2026-08-10T07:59:59.000Z").run();
        await harness.db.prepare(
          `UPDATE orchestration_leases
           SET holder = 'rival-job', fencing_token = fencing_token + 1, expires_at = ?
           WHERE id = 'staging-environment' AND expires_at <= ?`,
        ).bind("2026-08-10T10:00:00.000Z", NOW).run();
        return {
          appId: app.id,
          scheme: app.scheme,
          bundleId: app.bundleId,
          marketingVersion: targetVersion,
          buildNumber: "101",
          uploadId: `upload-${app.id}`,
        };
      },
      readback: async () => {
        readbackCalls += 1;
        throw new Error("readback must not run after lease reclaim");
      },
    },
    now: NOW,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stage, "testflight:au:upload");
  assert.deepEqual(stagedApps, ["au"]);
  assert.equal(readbackCalls, 0);
  assert.equal(guardCalls, 2);
  assert.equal(await acceptancePassedCount(harness.db, taskId), 0);
});

test("a lease reclaimed during the last iOS readback cannot persist or announce success", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const taskId = "task-ios-final-readback-reclaimed";
  await seedAcceptingTask(harness.db, taskId);
  const { gitOps, adapter } = webGate();
  const comments = [];
  let guardCalls = 0;

  const result = await executeStagingGate({
    job: stagingJob(taskId, ["ios"]),
    db: harness.db,
    client: { postComment: async (_taskId, body) => comments.push(body) },
    gitOps,
    adapter,
    iosApps: IOS_APPS,
    beforeExternalOperation: async () => { guardCalls += 1; },
    iosAdapter: {
      stage: async ({ app, targetVersion }) => ({
        appId: app.id,
        scheme: app.scheme,
        bundleId: app.bundleId,
        marketingVersion: targetVersion,
        buildNumber: app.id === "au" ? "101" : "202",
        uploadId: `upload-${app.id}`,
      }),
      readback: async ({ app }) => {
        if (app.id === "cn") {
          await harness.db.prepare(
            "UPDATE orchestration_leases SET expires_at = ? WHERE id = 'staging-environment'",
          ).bind("2026-08-10T07:59:59.000Z").run();
          await harness.db.prepare(
            `UPDATE orchestration_leases
             SET holder = 'rival-job', fencing_token = fencing_token + 1, expires_at = ?
             WHERE id = 'staging-environment' AND expires_at <= ?`,
          ).bind("2026-08-10T10:00:00.000Z", NOW).run();
        }
        return {
          processed: true,
          processingStatus: "processed",
          testGroup: app.testFlightGroup,
          membershipConfirmed: true,
          checkedAt: NOW,
        };
      },
    },
    now: NOW,
  });

  const cnSuccess = await harness.db.prepare(
    `SELECT COUNT(*) AS count FROM ios_testflight_deployments
     WHERE task_id = ? AND app_id = 'cn' AND status = 'succeeded'`,
  ).bind(taskId).first();
  const stagingAttempt = await harness.db.prepare(
    "SELECT status FROM staging_deployments WHERE task_id = ? ORDER BY attempt DESC LIMIT 1",
  ).bind(taskId).first();

  assert.equal(result.status, "failed");
  assert.equal(result.stage, "testflight:cn:processing");
  assert.equal(guardCalls, 9);
  assert.equal(Number(cnSuccess?.count ?? 0), 0);
  assert.equal(stagingAttempt?.status, "failed");
  assert.equal(await acceptancePassedCount(harness.db, taskId), 0);
  assert.equal(comments.filter((comment) => String(comment).startsWith("✅")).length, 0);
});

test("iOS staging fails closed with precise evidence for missing gate configuration", async (t) => {
  const cases = [
    { name: "missing iosApps", iosApps: null, iosAdapter: { stage() {}, readback() {} } },
    { name: "missing iosAdapter", iosApps: IOS_APPS, iosAdapter: null },
    { name: "malformed iosAdapter", iosApps: IOS_APPS, iosAdapter: { stage() {} } },
  ];

  for (const configCase of cases) {
    await t.test(configCase.name, async (t) => {
      const harness = await createCloudWorkerHarness();
      t.after(() => harness.dispose());
      const taskId = `task-${configCase.name.replaceAll(" ", "-")}`;
      await seedAcceptingTask(harness.db, taskId);
      const comments = [];
      const { gitOps, adapter } = webGate();

      const result = await executeStagingGate({
        job: stagingJob(taskId, ["ios"]),
        db: harness.db,
        client: { postComment: async (_taskId, body) => comments.push(body) },
        gitOps,
        adapter,
        iosApps: configCase.iosApps,
        iosAdapter: configCase.iosAdapter,
        now: NOW,
      });

      assert.equal(result.status, "failed");
      assert.equal(result.stage, "testflight:all:configuration");
      assert.equal(await acceptancePassedCount(harness.db, taskId), 0);
      assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "ready_for_development");
      assert.ok(comments.some((comment) => (
        String(comment).includes("阶段：testflight:all:configuration")
      )));
    });
  }
});

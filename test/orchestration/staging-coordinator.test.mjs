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
    testScheme: "E365AU",
    testTarget: "E365StoreKitTests",
    bundleId: "online.365english.app",
    testFlightGroup: "Internal Testing AU",
    buildNumberSource: "app-store-connect",
  },
  {
    id: "cn",
    name: "中国版",
    enabled: true,
    scheme: "E365CN",
    testScheme: "E365ChinaComplianceTests",
    testTarget: "E365ChinaComplianceTests",
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

async function productReworkFailureCount(db, taskId) {
  const row = await db.prepare(
    "SELECT round FROM task_rework WHERE task_id = ?",
  ).bind(taskId).first();
  return Number(row?.round ?? 0);
}

async function productDevelopmentTransitionCount(db, taskId) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM orchestration_events
     WHERE aggregate_type = 'task' AND aggregate_id = ?
       AND type IN ('task.staging_failed', 'task.acceptance_failed')`,
  ).bind(taskId).first();
  return Number(row?.count ?? 0);
}

async function retryStaging(db, taskId) {
  const aggregate = await loadAggregate(db, "task", taskId);
  const result = await dispatchCommand({
    db,
    command: parseCommandEnvelope({
      id: `${taskId}-retry-staging-${aggregate.version + 1}`,
      type: "retry_staging",
      aggregateType: "task",
      aggregateId: taskId,
      expectedVersion: aggregate.version + 1,
      actorId: "test",
      issuedAt: NOW,
      reason: "retry staging infrastructure",
      parameters: {},
    }),
    now: NOW,
  });
  assert.equal(result.status, "succeeded");
}

test("a repeated merge infrastructure failure is fingerprinted without consuming product rework", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const taskId = "task-merge-infrastructure-failure";
  await seedAcceptingTask(harness.db, taskId);
  const comments = [];
  let mergeAttempt = 0;
  const leakedCredentials = [
    "hunter2",
    "otherpass",
    "cookie-one",
    "cookie-two",
    "sk-1234567890abcdef",
    "sk-abcdef1234567890",
    "aaaaaaaa.bbbbbbbb.cccccccc",
    "dddddddd.eeeeeeee.ffffffff",
  ];
  const gitOps = {
    integrateTaskPr: async () => {
      mergeAttempt += 1;
      const credentials = mergeAttempt === 1
        ? {
            password: "hunter2",
            cookie: "cookie-one",
            key: "sk-1234567890abcdef",
            jwt: "aaaaaaaa.bbbbbbbb.cccccccc",
          }
        : {
            password: "otherpass",
            cookie: "cookie-two",
            key: "sk-abcdef1234567890",
            jwt: "dddddddd.eeeeeeee.ffffffff",
          };
      return {
        merged: false,
        error: [
          "merge unavailable",
          `remote=https://alice:${credentials.password}@example.com/repo`,
          `Cookie: session=${credentials.cookie}`,
          `credential ${credentials.key}`,
          `identity ${credentials.jwt}`,
        ].join("\n"),
      };
    },
    persistCandidate: async () => {
      throw new Error("candidate must not be persisted after a merge failure");
    },
  };
  const run = () => executeStagingGate({
    job: stagingJob(taskId, ["web"]),
    db: harness.db,
    client: { postComment: async (_taskId, body) => comments.push(body) },
    gitOps,
    adapter: webGate().adapter,
    now: NOW,
  });

  const first = await run();
  const firstAttempt = await harness.db.prepare(
    `SELECT error, failure_owner, failure_classification, failure_fingerprint
     FROM staging_deployments WHERE task_id = ? ORDER BY attempt DESC LIMIT 1`,
  ).bind(taskId).first();

  assert.equal(first.status, "failed");
  assert.equal(first.classification, "staging_infrastructure");
  assert.equal(first.stage, "merge");
  assert.equal(first.repeated, false);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(first.error, /\[REDACTED\]/);
  assert.equal(firstAttempt.failure_owner, "staging_infrastructure");
  assert.equal(firstAttempt.failure_classification, "staging_infrastructure");
  assert.equal(firstAttempt.failure_fingerprint, first.fingerprint);
  assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "acceptance_rejected");
  assert.equal(await productReworkFailureCount(harness.db, taskId), 0);
  assert.equal(await productDevelopmentTransitionCount(harness.db, taskId), 0);
  assert.match(comments.at(-1), /产品开发已完成，当前为提测基础设施故障/);
  assert.match(comments.at(-1), /重复故障：否/);
  for (const credential of leakedCredentials) {
    assert.doesNotMatch(JSON.stringify([first, firstAttempt, comments.at(-1)]), new RegExp(credential));
  }

  await retryStaging(harness.db, taskId);
  const second = await run();
  const attempts = await harness.db.prepare(
    `SELECT error, failure_owner, failure_classification, failure_fingerprint
     FROM staging_deployments WHERE task_id = ? ORDER BY attempt`,
  ).bind(taskId).all();

  assert.equal(second.status, "failed");
  assert.equal(second.classification, "staging_infrastructure");
  assert.equal(second.stage, "merge");
  assert.equal(second.repeated, true);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.deepEqual(attempts.results.map((attempt) => attempt.failure_owner), [
    "staging_infrastructure",
    "staging_infrastructure",
  ]);
  assert.deepEqual(attempts.results.map((attempt) => attempt.failure_classification), [
    "staging_infrastructure",
    "staging_infrastructure",
  ]);
  assert.deepEqual(attempts.results.map((attempt) => attempt.failure_fingerprint), [
    first.fingerprint,
    first.fingerprint,
  ]);
  assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "acceptance_rejected");
  assert.equal(await productReworkFailureCount(harness.db, taskId), 0);
  assert.equal(await productDevelopmentTransitionCount(harness.db, taskId), 0);
  assert.match(comments.at(-1), /产品开发已完成，当前为提测基础设施故障/);
  assert.match(comments.at(-1), /重复故障：是/);
  for (const credential of leakedCredentials) {
    assert.doesNotMatch(JSON.stringify([second, ...attempts.results, comments.at(-1)]), new RegExp(credential));
  }
});

test("staging fingerprints distinguish normalized errors that differ after the display limit", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const taskId = "task-long-staging-errors";
  await seedAcceptingTask(harness.db, taskId);
  const sharedPrefix = "merge infrastructure unavailable ".padEnd(340, "x");
  const errors = [`${sharedPrefix}first-tail`, `${sharedPrefix}second-tail`];
  let mergeAttempt = 0;
  const run = () => executeStagingGate({
    job: stagingJob(taskId, ["web"]),
    db: harness.db,
    client: { postComment: async () => ({}) },
    gitOps: {
      integrateTaskPr: async () => ({
        merged: false,
        error: errors[mergeAttempt++],
      }),
      persistCandidate: async () => {
        throw new Error("candidate must not be persisted after a merge failure");
      },
    },
    adapter: webGate().adapter,
    now: NOW,
  });

  const first = await run();
  await retryStaging(harness.db, taskId);
  const second = await run();
  const attempts = await harness.db.prepare(
    `SELECT error, failure_fingerprint
     FROM staging_deployments WHERE task_id = ? ORDER BY attempt`,
  ).bind(taskId).all();

  assert.equal(first.repeated, false);
  assert.equal(second.repeated, false);
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(first.error.length, 300);
  assert.equal(second.error, first.error);
  assert.deepEqual(attempts.results.map((attempt) => attempt.error), [first.error, second.error]);
  assert.deepEqual(attempts.results.map((attempt) => attempt.failure_fingerprint), [
    first.fingerprint,
    second.fingerprint,
  ]);
});

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
  const stagingAttempt = await harness.db.prepare(
    `SELECT failure_owner, failure_classification, failure_fingerprint
     FROM staging_deployments WHERE task_id = ? ORDER BY attempt DESC LIMIT 1`,
  ).bind(taskId).first();

  assert.equal(result.status, "failed");
  assert.equal(result.classification, "staging_infrastructure");
  assert.equal(result.stage, "testflight:cn:processing");
  assert.equal(result.repeated, false);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(stagingAttempt.failure_owner, "staging_infrastructure");
  assert.equal(stagingAttempt.failure_classification, "staging_infrastructure");
  assert.equal(stagingAttempt.failure_fingerprint, result.fingerprint);
  assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "acceptance_rejected");
  assert.equal(await productReworkFailureCount(harness.db, taskId), 0);
  assert.equal(await acceptancePassedCount(harness.db, taskId), 0);
  assert.ok(comments.some((comment) => String(comment).includes("阶段：testflight:cn:processing")));
  assert.match(comments.at(-1), /产品开发已完成，当前为提测基础设施故障/);
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
      assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "acceptance_rejected");
      assert.equal(await productReworkFailureCount(harness.db, taskId), 0);
      assert.ok(comments.some((comment) => (
        String(comment).includes("阶段：testflight:all:configuration")
      )));
    });
  }
});

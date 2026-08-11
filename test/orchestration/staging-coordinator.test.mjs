import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pollClickUpOnce } from "../../cloud/src/clickup-poller.mjs";
import { executeStagingGate } from "../../orchestration/application/staging-coordinator.mjs";
import { dispatchCommand } from "../../orchestration/application/dispatch-command.mjs";
import { parseCommandEnvelope } from "../../orchestration/domain/commands.mjs";
import { loadAggregate } from "../../orchestration/persistence/d1-aggregate-store.mjs";
import { saveSnapshot } from "../../orchestration/clickup/snapshot.mjs";
import {
  claimJob,
  completeJob,
  enqueueJob,
} from "../../orchestration/persistence/d1-runner-jobs.mjs";
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
    appStoreAppId: "0000000001",
    releaseMode: "automatic",
    reviewConfigurationRef: "app-store-review/au",
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
    appStoreAppId: "0000000002",
    releaseMode: "automatic",
    reviewConfigurationRef: "app-store-review/cn",
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

test("a missing staging adapter persists infrastructure ownership before rejection", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const taskId = "task-missing-staging-adapter";
  await seedAcceptingTask(harness.db, taskId);

  const result = await executeStagingGate({
    job: stagingJob(taskId, ["web"]),
    db: harness.db,
    client: { postComment: async () => ({}) },
    gitOps: webGate().gitOps,
    adapter: null,
    now: NOW,
  });
  const attempt = await harness.db.prepare(
    `SELECT status, stage, failure_owner, failure_classification, failure_fingerprint
     FROM staging_deployments WHERE task_id = ? ORDER BY attempt DESC LIMIT 1`,
  ).bind(taskId).first();

  assert.equal(result.status, "failed");
  assert.equal(result.stage, "preflight");
  assert.equal(result.classification, "staging_infrastructure");
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.stage, "preflight");
  assert.equal(attempt.failure_owner, "staging_infrastructure");
  assert.equal(attempt.failure_classification, "staging_infrastructure");
  assert.equal(attempt.failure_fingerprint, result.fingerprint);
  assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "acceptance_rejected");
});

test("staging rejects missing or non-array platforms before an attempt or external work", async (t) => {
  const cases = [
    { name: "missing", value: undefined, remove: true },
    { name: "string", value: "web" },
    { name: "null", value: null },
    { name: "object", value: { web: true } },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async (t) => {
      const harness = await createCloudWorkerHarness();
      t.after(() => harness.dispose());
      const taskId = `task-invalid-platforms-${testCase.name}`;
      await seedAcceptingTask(harness.db, taskId);
      const job = stagingJob(taskId, testCase.value);
      if (testCase.remove) delete job.payload.platforms;
      const calls = [];
      const comments = [];

      const result = await executeStagingGate({
        job,
        db: harness.db,
        client: { postComment: async (_taskId, body) => comments.push(body) },
        gitOps: {
          integrateTaskPr: async () => {
            calls.push("integrate");
            return { merged: true, candidateCommit: CANDIDATE_COMMIT, taskHead: TASK_COMMIT };
          },
          persistCandidate: async () => {
            calls.push("persist");
            return { persisted: true };
          },
        },
        adapter: {
          deploy: async () => {
            calls.push("deploy");
            return { releaseId: "must-not-deploy" };
          },
          readback: async () => {
            calls.push("readback");
            return { confirmed: true, gitSha: CANDIDATE_COMMIT };
          },
        },
        now: NOW,
      });

      assert.equal(result.status, "failed");
      assert.equal(result.stage, "preflight");
      assert.equal(result.classification, "staging_infrastructure");
      assert.match(result.error, /platforms must be an explicitly provided array/);
      assert.deepEqual(calls, []);
      assert.equal(comments.length, 1);
      assert.match(comments[0], /故障归属：staging_infrastructure/);
      const attempts = await harness.db.prepare(
        "SELECT COUNT(*) AS count FROM staging_deployments WHERE task_id = ?",
      ).bind(taskId).first();
      assert.equal(attempts.count, 0);
      assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "acceptance_rejected");
      const rejection = await harness.db.prepare(
        `SELECT actor_id, data FROM orchestration_events
         WHERE aggregate_type = 'task' AND aggregate_id = ?
           AND type = 'task.acceptance_rejected'
         ORDER BY aggregate_version DESC LIMIT 1`,
      ).bind(taskId).first();
      assert.equal(rejection.actor_id, "runner-staging");
      assert.equal(JSON.parse(rejection.data).evidenceId, `staging-${job.id}`);
    });
  }
});

test("an explicit empty platforms array remains valid Web-only staging evidence", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const taskId = "task-empty-platforms";
  await seedAcceptingTask(harness.db, taskId);

  const result = await executeStagingGate({
    job: stagingJob(taskId, []),
    db: harness.db,
    client: { postComment: async () => ({}) },
    ...webGate(),
    now: NOW,
  });

  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "ready_for_test");
});

test("production adapter module and factory failures stay inside the failed staging attempt boundary", async (t) => {
  const adapterModule = await import("../../orchestration/release/staging-command-adapter.mjs");
  assert.equal(typeof adapterModule.createProductionStagingAdapterFactory, "function");
  const cases = [
    {
      name: "invalid module path",
      moduleName: "missing-staging-adapter.mjs",
      error: /missing-staging-adapter|cannot find module/i,
    },
    {
      name: "throwing factory",
      moduleName: "throwing-staging-adapter.mjs",
      source: `export function createStagingAdapter() { throw new Error("staging factory exploded"); }\n`,
      error: /staging factory exploded/i,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async (t) => {
      const harness = await createCloudWorkerHarness();
      t.after(() => harness.dispose());
      const projectRoot = await mkdtemp(path.join(os.tmpdir(), "taskboard-stage-loader-"));
      t.after(() => rm(projectRoot, { recursive: true, force: true }));
      if (testCase.source) {
        await writeFile(path.join(projectRoot, testCase.moduleName), testCase.source);
      }
      const taskId = `task-adapter-${testCase.name.replaceAll(" ", "-")}`;
      await seedAcceptingTask(harness.db, taskId);
      const payload = stagingJob(taskId, ["web"]).payload;
      const jobId = `${taskId}-stage_task-4`;
      await enqueueJob(harness.db, {
        jobId,
        commandId: `auto-stage_task-${taskId}`,
        jobType: "stage_task",
        payload,
        payloadHash: "adapter-boundary",
        expiresAt: "2026-08-10T10:00:00.000Z",
        createdAt: NOW,
      });
      const job = await claimJob(harness.db, {
        deviceId: "production-runner",
        jobType: "stage_task",
        now: NOW,
      });
      let gitCalls = 0;
      const adapterFactory = adapterModule.createProductionStagingAdapterFactory({
        runtime: { stagingAdapterModule: testCase.moduleName },
        projectRoot,
      });

      const result = await executeStagingGate({
        job,
        db: harness.db,
        client: { postComment: async () => ({}) },
        gitOps: {
          integrateTaskPr: async () => { gitCalls += 1; return { merged: false }; },
          persistCandidate: async () => { gitCalls += 1; return { persisted: false }; },
        },
        adapterFactory,
        now: NOW,
      });
      await completeJob(harness.db, {
        jobId,
        deviceId: "production-runner",
        fencingToken: job.fencingToken,
        status: "failed",
        result,
        now: "2026-08-10T08:00:01.000Z",
      });

      assert.equal(result.status, "failed");
      assert.equal(result.stage, "preflight");
      assert.match(result.error, testCase.error);
      assert.equal(gitCalls, 0);
      const jobs = await harness.db.prepare(
        "SELECT status, result FROM runner_jobs WHERE id = ?",
      ).bind(jobId).all();
      assert.equal(jobs.results.length, 1);
      assert.equal(jobs.results[0].status, "failed");
      assert.equal(JSON.parse(jobs.results[0].result).classification, "staging_infrastructure");
      const attempts = await harness.db.prepare(
        `SELECT status, failure_owner FROM staging_deployments
         WHERE task_id = ? ORDER BY attempt`,
      ).bind(taskId).all();
      assert.deepEqual(attempts.results, [{
        status: "failed",
        failure_owner: "staging_infrastructure",
      }]);
      assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "acceptance_rejected");

      const unchangedAt = "2026-08-10T08:00:02.000Z";
      await saveSnapshot(harness.db, {
        type: "task",
        snapshot: {
          id: taskId,
          listId: "task-list",
          name: "Adapter boundary",
          status: "acceptance_rejected",
          targetVersion: "1.2.3",
          assignee: null,
          updatedAt: unchangedAt,
          fieldsHash: "unchanged-rejection",
        },
        readAt: unchangedAt,
      });
      const config = {
        teamId: "team",
        spaceId: "space",
        lists: {
          task: { id: "task", name: "task" },
          version: { id: "version", name: "version" },
          taskSandbox: { id: "task-list", name: "task sandbox" },
          versionSandbox: { id: "version-list", name: "version sandbox" },
        },
        taskStatusMap: { "待开发": "ready_for_development" },
        versionStatusMap: { "进行中": "active" },
        fields: {
          task: {},
          version: {},
          taskSandbox: {
            "自动化纳管": { id: "managed", type: "checkbox" },
            "目标版本": { id: "version-field", type: "short_text" },
          },
          versionSandbox: { "发布阻塞": { id: "blocked", type: "drop_down" } },
        },
      };
      const poll = await pollClickUpOnce({
        DB: harness.db,
        CLICKUP_API_TOKEN: "redacted",
        CLICKUP_CONFIG: JSON.stringify(config),
        CLICKUP_LIST_SET: "sandbox",
        CLICKUP_JOB_RETRY_MINUTES: "5",
        clientFactory: async () => ({
          getTasksByList: async () => [{
            id: taskId,
            name: "Adapter boundary",
            list: { id: "task-list" },
            status: { status: "验收不通过" },
            custom_fields: [
              { id: "managed", value: true },
              { id: "version-field", value: "1.2.3" },
            ],
            updated_at: unchangedAt,
          }],
          getVersionsByList: async () => [{
            id: "version-1.2.3",
            name: "1.2.3",
            status: { status: "进行中" },
            custom_fields: [{ id: "blocked", value: false }],
          }],
          postComment: async () => ({}),
        }),
      }, { now: "2026-08-10T09:00:00.000Z" });
      assert.deepEqual(poll.commands, []);
      const queued = await harness.db.prepare(
        "SELECT job_type FROM runner_jobs WHERE status = 'queued' ORDER BY job_type",
      ).all();
      assert.deepEqual(queued.results, []);
      const developJobs = await harness.db.prepare(
        "SELECT COUNT(*) AS count FROM runner_jobs WHERE job_type = 'develop'",
      ).first();
      assert.equal(developJobs.count, 0);
    });
  }
});

test("staging rejects a PR head that differs from the accepted commit before persistence or deploy", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const taskId = "task-unaccepted-pr-head";
  await seedAcceptingTask(harness.db, taskId);
  let persistCalls = 0;
  let deployCalls = 0;
  let readbackCalls = 0;
  const changedHead = "3333333333333333333333333333333333333333";

  const result = await executeStagingGate({
    job: stagingJob(taskId, ["web"]),
    db: harness.db,
    client: { postComment: async () => ({}) },
    gitOps: {
      integrateTaskPr: async () => ({
        merged: true,
        candidateCommit: CANDIDATE_COMMIT,
        taskHead: changedHead,
        prNumber: 42,
      }),
      persistCandidate: async () => {
        persistCalls += 1;
        return { persisted: true };
      },
    },
    adapter: {
      deploy: async () => {
        deployCalls += 1;
        return { releaseId: "must-not-deploy" };
      },
      readback: async () => {
        readbackCalls += 1;
        return { confirmed: true, gitSha: CANDIDATE_COMMIT };
      },
    },
    now: NOW,
  });
  const attempt = await harness.db.prepare(
    `SELECT status, stage, task_commit, failure_owner
     FROM staging_deployments WHERE task_id = ? ORDER BY attempt DESC LIMIT 1`,
  ).bind(taskId).first();

  assert.equal(result.status, "failed");
  assert.equal(result.stage, "merge");
  assert.match(result.error, /accepted commit.*does not match PR head/i);
  assert.equal(persistCalls, 0);
  assert.equal(deployCalls, 0);
  assert.equal(readbackCalls, 0);
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.stage, "merge");
  assert.equal(attempt.task_commit, TASK_COMMIT);
  assert.equal(attempt.failure_owner, "staging_infrastructure");
  assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "acceptance_rejected");
});

test("staging persists and deploys when the PR head equals the accepted commit", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const taskId = "task-accepted-pr-head";
  await seedAcceptingTask(harness.db, taskId);
  let persistCalls = 0;
  let deployCalls = 0;
  const gate = webGate();

  const result = await executeStagingGate({
    job: stagingJob(taskId, ["web"]),
    db: harness.db,
    client: { postComment: async () => ({}) },
    gitOps: {
      ...gate.gitOps,
      persistCandidate: async (input) => {
        persistCalls += 1;
        return gate.gitOps.persistCandidate(input);
      },
    },
    adapter: {
      ...gate.adapter,
      deploy: async (input) => {
        deployCalls += 1;
        return gate.adapter.deploy(input);
      },
    },
    now: NOW,
  });

  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(persistCalls, 1);
  assert.equal(deployCalls, 1);
  assert.equal((await loadAggregate(harness.db, "task", taskId)).state, "ready_for_test");
});

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
    job: stagingJob(taskId, ["web", "IoS"]),
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

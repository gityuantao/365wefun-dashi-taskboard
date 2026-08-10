import assert from "node:assert/strict";
import test from "node:test";

import { executeIosStagingGate } from "../../orchestration/application/ios-staging-coordinator.mjs";
import { loadIosApps } from "../../orchestration/ios/app-registry.mjs";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";

const CANDIDATE_A = "1111111111111111111111111111111111111111";
const CANDIDATE_B = "2222222222222222222222222222222222222222";
const TARGET_VERSION = "1.2.3";
const NOW = "2026-08-10T08:00:00.000Z";
const CURRENT_APPS = [
  {
    id: "au",
    name: "海外版",
    enabled: true,
    scheme: "E365AU",
    bundleId: "online.365english.app",
    testFlightGroup: "AU Internal Testing",
    buildNumberSource: "app-store-connect",
  },
  {
    id: "cn",
    name: "中国版",
    enabled: true,
    scheme: "E365CN",
    bundleId: "online.365english.china",
    testFlightGroup: "CN Internal Testing",
    buildNumberSource: "app-store-connect",
  },
];

function createClient() {
  const comments = [];
  return {
    comments,
    async postComment(taskId, text) {
      comments.push({ taskId, text });
    },
  };
}

function confirmedReadback(app) {
  return {
    processed: true,
    processingStatus: "processed",
    testGroup: app.testFlightGroup,
    membershipConfirmed: true,
    checkedAt: NOW,
  };
}

function createAdapter({ stageFor, readbackFor } = {}) {
  const calls = [];
  return {
    calls,
    async stage({ candidateCommit, targetVersion, app }) {
      calls.push(`stage:${app.id}:${candidateCommit}`);
      if (stageFor) return stageFor({ candidateCommit, targetVersion, app });
      return {
        appId: app.id,
        scheme: app.scheme,
        bundleId: app.bundleId,
        marketingVersion: targetVersion,
        buildNumber: app.id === "au" ? "41" : app.id === "cn" ? "52" : "63",
        uploadId: `upload-${app.id}-${candidateCommit.slice(0, 6)}`,
      };
    },
    async readback({ app, staged }) {
      calls.push(`readback:${app.id}:${staged.uploadId}`);
      return readbackFor ? readbackFor({ app, staged }) : confirmedReadback(app);
    },
  };
}

async function deploymentRows(db) {
  return (await db.prepare(`
    SELECT task_id, candidate_commit, app_id, attempt, stage, status,
           build_number, upload_id, processing_status, test_group,
           membership_confirmed, error
    FROM ios_testflight_deployments
    ORDER BY rowid
  `).all()).results;
}

async function execute({ db, client, adapter, apps = CURRENT_APPS, candidateCommit = CANDIDATE_A }) {
  return executeIosStagingGate({
    db,
    client,
    taskId: "task-ios-1",
    candidateCommit,
    targetVersion: TARGET_VERSION,
    apps: loadIosApps(apps),
    adapter,
    now: NOW,
  });
}

test("AU success and CN upload failure fails the aggregate at only the CN upload", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const client = createClient();
  const adapter = createAdapter({
    stageFor({ candidateCommit, targetVersion, app }) {
      if (app.id === "cn") throw new Error("upload rejected token=top-secret-token");
      return {
        appId: app.id,
        scheme: app.scheme,
        bundleId: app.bundleId,
        marketingVersion: targetVersion,
        buildNumber: "41",
        uploadId: `upload-au-${candidateCommit.slice(0, 6)}`,
      };
    },
  });

  const result = await execute({ db: harness.db, client, adapter });

  assert.equal(result.status, "failed");
  assert.deepEqual(result.apps.map(({ id }) => id), ["au"]);
  assert.deepEqual(
    { appId: result.error.appId, stage: result.error.stage },
    { appId: "cn", stage: "upload" },
  );
  assert.doesNotMatch(result.error.message, /top-secret-token/);
  assert.deepEqual(adapter.calls, [
    `stage:au:${CANDIDATE_A}`,
    "readback:au:upload-au-111111",
    `stage:cn:${CANDIDATE_A}`,
  ]);
  assert.equal(client.comments.length, 1);
  assert.match(client.comments[0].text, /中国版.*E365CN.*online\.365english\.china.*1\.2\.3/s);
  assert.match(client.comments[0].text, /阶段：upload/);
  assert.doesNotMatch(client.comments[0].text, /海外版|top-secret-token/);
});

test("failure evidence redacts credentials from D1, result, and ClickUp comment", async (t) => {
  const cases = [
    {
      name: "quoted JSON credentials",
      message: 'request failed: {"token":"json-token-value","password":"json-password-value","key":"json-key-value","secret":"json-secret-value"}',
      secrets: ["json-token-value", "json-password-value", "json-key-value", "json-secret-value"],
    },
    {
      name: "quoted JSON Authorization bearer",
      message: 'request failed: {"Authorization":"Bearer json-bearer-value"}',
      secrets: ["json-bearer-value"],
    },
    {
      name: "Authorization Basic header",
      message: "request failed: Authorization: Basic dXNlcjpzdXBlci1zZWNyZXQ=",
      secrets: ["dXNlcjpzdXBlci1zZWNyZXQ="],
    },
  ];

  for (const credentialCase of cases) {
    await t.test(credentialCase.name, async (subtest) => {
      const harness = await createCloudWorkerHarness();
      subtest.after(() => harness.dispose());
      const client = createClient();
      const adapter = createAdapter({
        stageFor() {
          throw new Error(credentialCase.message);
        },
      });

      const result = await execute({
        db: harness.db,
        client,
        adapter,
        apps: [CURRENT_APPS[0]],
      });

      const rows = await deploymentRows(harness.db);
      const sinks = [result.error.message, rows[0].error, client.comments[0].text];
      for (const sink of sinks) {
        assert.match(sink, /\[REDACTED\]/);
        for (const secret of credentialCase.secrets) {
          assert.equal(String(sink).includes(secret), false, `${credentialCase.name} leaked ${secret}`);
        }
      }
    });
  }
});

test("both Apps uploaded but CN still processing fails the aggregate", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const client = createClient();
  const adapter = createAdapter({
    readbackFor({ app }) {
      if (app.id === "cn") {
        return {
          processed: false,
          processingStatus: "processing",
          testGroup: app.testFlightGroup,
          membershipConfirmed: false,
          checkedAt: NOW,
        };
      }
      return confirmedReadback(app);
    },
  });

  const result = await execute({ db: harness.db, client, adapter });

  assert.equal(result.status, "failed");
  assert.equal(result.error.appId, "cn");
  assert.equal(result.error.stage, "processing");
  assert.deepEqual(result.apps.map(({ id }) => id), ["au"]);
  const rows = await deploymentRows(harness.db);
  assert.deepEqual(
    rows.map(({ app_id, stage, status, processing_status }) => ({ app_id, stage, status, processing_status })),
    [
      { app_id: "au", stage: "complete", status: "succeeded", processing_status: "processed" },
      { app_id: "cn", stage: "processing", status: "failed", processing_status: "processing" },
    ],
  );
});

test("both Apps processed but CN group membership missing fails the aggregate", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const client = createClient();
  const adapter = createAdapter({
    readbackFor({ app }) {
      const observed = confirmedReadback(app);
      if (app.id === "cn") delete observed.testGroup;
      return observed;
    },
  });

  const result = await execute({ db: harness.db, client, adapter });

  assert.equal(result.status, "failed");
  assert.equal(result.error.appId, "cn");
  assert.equal(result.error.stage, "internal_testing");
  assert.deepEqual(result.apps.map(({ id }) => id), ["au"]);
});

test("a real-shaped adapter testGroup error is classified as internal testing", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const client = createClient();
  const adapter = createAdapter({
    readbackFor() {
      throw new Error("TestFlight readback evidence testGroup does not exactly match staged build");
    },
  });

  const result = await execute({
    db: harness.db,
    client,
    adapter,
    apps: [CURRENT_APPS[0]],
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.stage, "internal_testing");
});

test("every enabled App fully confirmed completes with persistent per-App evidence and one structured comment", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const client = createClient();
  const adapter = createAdapter();

  const result = await execute({ db: harness.db, client, adapter });

  assert.equal(result.status, "completed");
  assert.deepEqual(
    result.apps.map(({ id, name, scheme, bundleId, marketingVersion, buildNumber, uploadId, testGroup, membershipConfirmed }) => ({
      id,
      name,
      scheme,
      bundleId,
      marketingVersion,
      buildNumber,
      uploadId,
      testGroup,
      membershipConfirmed,
    })),
    [
      {
        id: "au",
        name: "海外版",
        scheme: "E365AU",
        bundleId: "online.365english.app",
        marketingVersion: "1.2.3",
        buildNumber: "41",
        uploadId: "upload-au-111111",
        testGroup: "AU Internal Testing",
        membershipConfirmed: true,
      },
      {
        id: "cn",
        name: "中国版",
        scheme: "E365CN",
        bundleId: "online.365english.china",
        marketingVersion: "1.2.3",
        buildNumber: "52",
        uploadId: "upload-cn-111111",
        testGroup: "CN Internal Testing",
        membershipConfirmed: true,
      },
    ],
  );
  assert.deepEqual(adapter.calls, [
    `stage:au:${CANDIDATE_A}`,
    "readback:au:upload-au-111111",
    `stage:cn:${CANDIDATE_A}`,
    "readback:cn:upload-cn-111111",
  ]);
  assert.equal(client.comments.length, 1);
  const comment = client.comments[0].text;
  for (const expected of [
    "海外版",
    "E365AU",
    "online.365english.app",
    "1.2.3",
    "41",
    "upload-au-111111",
    "AU Internal Testing",
    "中国版",
    "E365CN",
    "online.365english.china",
    "52",
    "upload-cn-111111",
    "CN Internal Testing",
  ]) {
    assert.ok(comment.includes(expected), `missing ${expected} from success comment`);
  }
});

test("a success evidence comment delivery failure keeps the gate failed and retryable", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const client = {
    async postComment() {
      throw new Error("ClickUp unavailable token=comment-delivery-secret");
    },
  };

  const result = await execute({
    db: harness.db,
    client,
    adapter: createAdapter(),
    apps: [CURRENT_APPS[0]],
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(
    {
      appId: result.error.appId,
      stage: result.error.stage,
      retryable: result.error.retryable,
    },
    { appId: "all", stage: "comment", retryable: true },
  );
  assert.match(result.error.message, /\[REDACTED\]/);
  assert.doesNotMatch(result.error.message, /comment-delivery-secret/);
  assert.deepEqual(result.apps.map(({ id }) => id), ["au"]);
  assert.deepEqual(
    (await deploymentRows(harness.db)).map(({ status }) => status),
    ["succeeded"],
  );
  const retryClient = createClient();
  const retryAdapter = createAdapter({
    stageFor() {
      throw new Error("comment retry must not upload again");
    },
  });

  const retry = await execute({
    db: harness.db,
    client: retryClient,
    adapter: retryAdapter,
    apps: [CURRENT_APPS[0]],
  });

  assert.equal(retry.status, "completed");
  assert.deepEqual(retryAdapter.calls, ["readback:au:upload-au-111111"]);
  assert.equal(retryClient.comments.length, 1);
});

test("a third enabled App is staged in registry order without coordinator branching", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const client = createClient();
  const adapter = createAdapter();
  const apps = [
    ...CURRENT_APPS,
    {
      id: "nz",
      name: "新西兰版",
      enabled: true,
      scheme: "E365NZ",
      bundleId: "online.365english.nz",
      testFlightGroup: "NZ Internal Testing",
      buildNumberSource: "app-store-connect",
    },
  ];

  const result = await execute({ db: harness.db, client, adapter, apps });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.apps.map(({ id }) => id), ["au", "cn", "nz"]);
  assert.deepEqual(
    adapter.calls.filter((call) => call.startsWith("stage:")).map((call) => call.split(":")[1]),
    ["au", "cn", "nz"],
  );
});

test("retrying the exact Candidate reuses every fully confirmed App", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const client = createClient();
  const firstAdapter = createAdapter();
  const first = await execute({ db: harness.db, client, adapter: firstAdapter });
  assert.equal(first.status, "completed");
  const retryAdapter = createAdapter({
    stageFor() {
      throw new Error("a reusable App must not be uploaded again");
    },
    readbackFor({ app, staged }) {
      assert.deepEqual(staged, {
        appId: app.id,
        scheme: app.scheme,
        bundleId: app.bundleId,
        marketingVersion: TARGET_VERSION,
        buildNumber: app.id === "au" ? "41" : "52",
        uploadId: `upload-${app.id}-111111`,
      });
      return confirmedReadback(app);
    },
  });

  const retry = await execute({ db: harness.db, client, adapter: retryAdapter });

  assert.equal(retry.status, "completed");
  assert.deepEqual(retry.apps.map(({ id, reused }) => ({ id, reused })), [
    { id: "au", reused: true },
    { id: "cn", reused: true },
  ]);
  assert.deepEqual(retryAdapter.calls, [
    "readback:au:upload-au-111111",
    "readback:cn:upload-cn-111111",
  ]);
  assert.equal((await deploymentRows(harness.db)).length, 2);
});

test("a persisted success fails closed when authoritative reuse readback is no longer confirmed", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const client = createClient();
  const first = await execute({ db: harness.db, client, adapter: createAdapter() });
  assert.equal(first.status, "completed");
  const retryAdapter = createAdapter({
    stageFor() {
      throw new Error("persisted success must skip upload");
    },
    readbackFor({ app }) {
      return app.id === "au"
        ? {
          processed: false,
          processingStatus: "processing",
          testGroup: app.testFlightGroup,
          membershipConfirmed: false,
          checkedAt: NOW,
        }
        : confirmedReadback(app);
    },
  });

  const retry = await execute({ db: harness.db, client, adapter: retryAdapter });

  assert.equal(retry.status, "failed");
  assert.deepEqual(
    { appId: retry.error.appId, stage: retry.error.stage },
    { appId: "au", stage: "processing" },
  );
  assert.deepEqual(retryAdapter.calls, ["readback:au:upload-au-111111"]);
  const rows = await deploymentRows(harness.db);
  assert.deepEqual(
    rows.map(({ app_id, status }) => ({ app_id, status })),
    [
      { app_id: "au", status: "failed" },
      { app_id: "cn", status: "succeeded" },
    ],
  );
});

test("a success-shaped row without a complete lifecycle is not reusable", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await harness.db.prepare(`
    INSERT INTO ios_testflight_deployments (
      task_id, candidate_commit, app_id, attempt, scheme, bundle_id,
      marketing_version, build_number, upload_id, processing_status,
      test_group, membership_confirmed, stage, status, started_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, '40', 'incomplete-upload', 'processed', ?, 1, 'processing', 'succeeded', ?)
  `).bind(
    "task-ios-1",
    CANDIDATE_A,
    "au",
    "E365AU",
    "online.365english.app",
    TARGET_VERSION,
    "AU Internal Testing",
    NOW,
  ).run();
  const client = createClient();
  const adapter = createAdapter();

  const result = await execute({
    db: harness.db,
    client,
    adapter,
    apps: [CURRENT_APPS[0]],
  });

  assert.equal(result.status, "completed");
  assert.equal(result.apps[0].reused, false);
  assert.deepEqual(adapter.calls, [
    `stage:au:${CANDIDATE_A}`,
    "readback:au:upload-au-111111",
  ]);
});

test("a new Candidate invokes every App again even when marketing version is unchanged", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const client = createClient();
  const firstAdapter = createAdapter();
  const first = await execute({ db: harness.db, client, adapter: firstAdapter });
  assert.equal(first.status, "completed");
  const nextAdapter = createAdapter();

  const next = await execute({
    db: harness.db,
    client,
    adapter: nextAdapter,
    candidateCommit: CANDIDATE_B,
  });

  assert.equal(next.status, "completed");
  assert.deepEqual(next.apps.map(({ id, reused }) => ({ id, reused })), [
    { id: "au", reused: false },
    { id: "cn", reused: false },
  ]);
  assert.deepEqual(
    nextAdapter.calls.filter((call) => call.startsWith("stage:")),
    [`stage:au:${CANDIDATE_B}`, `stage:cn:${CANDIDATE_B}`],
  );
  assert.equal((await deploymentRows(harness.db)).length, 4);
});

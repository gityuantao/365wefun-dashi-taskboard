import assert from "node:assert/strict";
import test from "node:test";

import { executeIosStagingGate } from "../../orchestration/application/ios-staging-coordinator.mjs";
import { loadIosApps } from "../../orchestration/ios/app-registry.mjs";
import { createTestFlightAdapter } from "../../orchestration/ios/testflight-adapter.mjs";
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
    testScheme: "E365AU",
    testTarget: "E365StoreKitTests",
    bundleId: "online.365english.app",
    testFlightGroup: "AU Internal Testing",
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
    testFlightGroup: "CN Internal Testing",
    buildNumberSource: "app-store-connect",
    appStoreAppId: "0000000002",
    releaseMode: "automatic",
    reviewConfigurationRef: "app-store-review/cn",
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

function createProductionReadbackAdapter(evidence) {
  return createTestFlightAdapter({
    runtime: {
      repoPath: process.cwd(),
      iosTestFlightTimeoutMs: 5_000,
      iosTestFlightStageCommand: [
        process.execPath,
        "-e",
        "console.error('reuse must not invoke the upload command'); process.exit(97);",
      ],
      iosTestFlightReadbackCommand: [
        process.execPath,
        "-e",
        `console.log(${JSON.stringify(JSON.stringify(evidence))});`,
      ],
    },
    projectRoot: process.cwd(),
  });
}

function createProductionStageAdapter() {
  const expectedTestFields = {
    IOS_TEST_SCHEME: "E365AU",
    IOS_TEST_TARGET: "E365StoreKitTests",
  };
  const stageSource = [
    `const expected = ${JSON.stringify(expectedTestFields)};`,
    "for (const [field, value] of Object.entries(expected)) {",
    "  if (process.env[field] !== value) {",
    "    console.error(`${field} was ${JSON.stringify(process.env[field])}, expected ${JSON.stringify(value)}`);",
    "    process.exit(1);",
    "  }",
    "}",
    "console.log(JSON.stringify({",
    "  appId: process.env.IOS_APP_ID,",
    "  scheme: process.env.IOS_SCHEME,",
    "  bundleId: process.env.IOS_BUNDLE_ID,",
    "  marketingVersion: process.env.IOS_MARKETING_VERSION,",
    "  buildNumber: '77',",
    "  uploadId: 'upload-production-77'",
    "}));",
  ].join("\n");
  const readbackSource = [
    "console.log(JSON.stringify({",
    "  bundleId: process.env.IOS_BUNDLE_ID,",
    "  marketingVersion: process.env.IOS_MARKETING_VERSION,",
    "  buildNumber: process.env.IOS_BUILD_NUMBER,",
    "  testGroup: process.env.IOS_TESTFLIGHT_GROUP,",
    "  processed: true,",
    "  processingStatus: 'processed',",
    "  membershipConfirmed: true,",
    `  checkedAt: ${JSON.stringify(NOW)}`,
    "}));",
  ].join("\n");
  return createTestFlightAdapter({
    runtime: {
      repoPath: process.cwd(),
      iosTestFlightTimeoutMs: 5_000,
      iosTestFlightStageCommand: [process.execPath, "-e", stageSource],
      iosTestFlightReadbackCommand: [process.execPath, "-e", readbackSource],
    },
    projectRoot: process.cwd(),
  });
}

async function deploymentRows(db) {
  return (await db.prepare(`
    SELECT task_id, candidate_commit, app_id, attempt, stage, status,
           build_number, upload_id, processing_status, test_group,
           membership_confirmed, failure_classification, error, started_at, completed_at
    FROM ios_testflight_deployments
    ORDER BY rowid
  `).all()).results;
}

async function execute({
  db,
  client,
  adapter,
  apps = CURRENT_APPS,
  candidateCommit = CANDIDATE_A,
  targetVersion = TARGET_VERSION,
}) {
  return executeIosStagingGate({
    db,
    client,
    taskId: "task-ios-1",
    candidateCommit,
    targetVersion,
    apps: loadIosApps(apps),
    adapter,
    now: NOW,
  });
}

test("ClickUp v-prefixed target version accepts normalized iOS stage evidence", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());

  const result = await execute({
    db: harness.db,
    client: createClient(),
    adapter: createAdapter({
      stageFor({ candidateCommit, app }) {
        return {
          appId: app.id,
          scheme: app.scheme,
          bundleId: app.bundleId,
          marketingVersion: "1.2.3",
          buildNumber: "41",
          uploadId: `upload-au-${candidateCommit.slice(0, 6)}`,
        };
      },
    }),
    apps: [CURRENT_APPS[0]],
    targetVersion: "v1.2.3",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.apps[0].marketingVersion, "1.2.3");
});

test("registry test scheme and target reach the production stage adapter exactly", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());

  const result = await execute({
    db: harness.db,
    client: createClient(),
    adapter: createProductionStageAdapter(),
    apps: [CURRENT_APPS[0]],
  });

  assert.equal(result.status, "completed");
  assert.equal(result.apps[0].buildNumber, "77");
});

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
      testScheme: "E365NZTests",
      testTarget: "E365NZTests",
      bundleId: "online.365english.nz",
      testFlightGroup: "NZ Internal Testing",
      buildNumberSource: "app-store-connect",
      appStoreAppId: "0000000003",
      releaseMode: "automatic",
      reviewConfigurationRef: "app-store-review/nz",
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

test("a transient reuse readback error records a separate observation attempt and retries the same upload", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const client = createClient();
  const first = await execute({ db: harness.db, client, adapter: createAdapter() });
  assert.equal(first.status, "completed");
  const historicalRows = await deploymentRows(harness.db);
  const retryAdapter = createAdapter({
    stageFor() {
      throw new Error("persisted success must skip upload");
    },
    readbackFor() {
      throw new Error("App Store Connect network timeout token=round-three-secret");
    },
  });

  const retry = await execute({ db: harness.db, client, adapter: retryAdapter });

  assert.equal(retry.status, "failed");
  assert.deepEqual(
    {
      appId: retry.error.appId,
      stage: retry.error.stage,
      classification: retry.error.classification,
      retryable: retry.error.retryable,
    },
    {
      appId: "au",
      stage: "processing",
      classification: "observation_error",
      retryable: true,
    },
  );
  assert.deepEqual(retryAdapter.calls, ["readback:au:upload-au-111111"]);
  assert.doesNotMatch(retry.error.message, /round-three-secret/);
  const failedRows = await deploymentRows(harness.db);
  assert.deepEqual(failedRows.slice(0, historicalRows.length), historicalRows);
  assert.deepEqual(failedRows.at(-1), {
    task_id: "task-ios-1",
    candidate_commit: CANDIDATE_A,
    app_id: "au",
    attempt: 2,
    stage: "processing",
    status: "failed",
    build_number: "41",
    upload_id: "upload-au-111111",
    processing_status: null,
    test_group: "AU Internal Testing",
    membership_confirmed: null,
    failure_classification: "observation_error",
    error: "App Store Connect network timeout token=[REDACTED]",
    started_at: NOW,
    completed_at: NOW,
  });
  const recoveryAdapter = createAdapter({
    stageFor() {
      throw new Error("transient recovery must not upload again");
    },
  });

  const recovered = await execute({ db: harness.db, client, adapter: recoveryAdapter });

  assert.equal(recovered.status, "completed");
  assert.deepEqual(recoveryAdapter.calls, [
    "readback:au:upload-au-111111",
    "readback:cn:upload-cn-111111",
  ]);
  assert.deepEqual(await deploymentRows(harness.db), failedRows);
});

test("authoritative missing membership records a separate stale attempt for later readback", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const client = createClient();
  const first = await execute({ db: harness.db, client, adapter: createAdapter() });
  assert.equal(first.status, "completed");
  const historicalRows = await deploymentRows(harness.db);
  const staleAdapter = createAdapter({
    stageFor() {
      throw new Error("membership recheck must not upload again");
    },
    readbackFor({ app }) {
      return {
        ...confirmedReadback(app),
        membershipConfirmed: false,
      };
    },
  });

  const stale = await execute({ db: harness.db, client, adapter: staleAdapter });

  assert.equal(stale.status, "failed");
  assert.deepEqual(
    {
      appId: stale.error.appId,
      stage: stale.error.stage,
      classification: stale.error.classification,
      retryable: stale.error.retryable,
    },
    {
      appId: "au",
      stage: "internal_testing",
      classification: "authoritative_stale",
      retryable: false,
    },
  );
  assert.deepEqual(staleAdapter.calls, ["readback:au:upload-au-111111"]);
  const failedRows = await deploymentRows(harness.db);
  assert.deepEqual(failedRows.slice(0, historicalRows.length), historicalRows);
  assert.deepEqual(failedRows.at(-1), {
    task_id: "task-ios-1",
    candidate_commit: CANDIDATE_A,
    app_id: "au",
    attempt: 2,
    stage: "internal_testing",
    status: "failed",
    build_number: "41",
    upload_id: "upload-au-111111",
    processing_status: "processed",
    test_group: "AU Internal Testing",
    membership_confirmed: 0,
    failure_classification: "authoritative_stale",
    error: "TestFlight build is not confirmed in AU Internal Testing",
    started_at: NOW,
    completed_at: NOW,
  });
  const recoveryAdapter = createAdapter({
    stageFor() {
      throw new Error("membership recovery must not upload again");
    },
  });

  const recovered = await execute({ db: harness.db, client, adapter: recoveryAdapter });

  assert.equal(recovered.status, "completed");
  assert.deepEqual(recoveryAdapter.calls, [
    "readback:au:upload-au-111111",
    "readback:cn:upload-cn-111111",
  ]);
  assert.deepEqual(await deploymentRows(harness.db), failedRows);
});

test("production readback mismatch audits actual observation while preserving reusable success and skipping upload", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const client = createClient();
  const app = CURRENT_APPS[0];
  const first = await execute({
    db: harness.db,
    client,
    adapter: createAdapter(),
    apps: [app],
  });
  assert.equal(first.status, "completed");
  const historicalRows = await deploymentRows(harness.db);
  const observedGroup = "AU Reviewers";
  const staleAdapter = createProductionReadbackAdapter({
    bundleId: app.bundleId,
    marketingVersion: TARGET_VERSION,
    buildNumber: "41",
    testGroup: observedGroup,
    processed: false,
    processingStatus: "processing",
    membershipConfirmed: false,
    checkedAt: NOW,
    token: "must-not-escape-production-token",
    rawBody: "must-not-escape-raw-body",
  });

  const stale = await execute({
    db: harness.db,
    client,
    adapter: staleAdapter,
    apps: [app],
  });

  assert.deepEqual(
    {
      status: stale.status,
      appId: stale.error.appId,
      stage: stale.error.stage,
      classification: stale.error.classification,
      retryable: stale.error.retryable,
    },
    {
      status: "failed",
      appId: "au",
      stage: "internal_testing",
      classification: "authoritative_stale",
      retryable: false,
    },
  );
  const failedRows = await deploymentRows(harness.db);
  assert.deepEqual(failedRows.slice(0, historicalRows.length), historicalRows);
  assert.deepEqual(failedRows.at(-1), {
    task_id: "task-ios-1",
    candidate_commit: CANDIDATE_A,
    app_id: "au",
    attempt: 2,
    stage: "internal_testing",
    status: "failed",
    build_number: "41",
    upload_id: "upload-au-111111",
    processing_status: "processing",
    test_group: observedGroup,
    membership_confirmed: 0,
    failure_classification: "authoritative_stale",
    error: "TestFlight readback evidence testGroup does not exactly match staged build",
    started_at: NOW,
    completed_at: NOW,
  });
  assert.doesNotMatch(
    JSON.stringify({ result: stale, rows: failedRows, comments: client.comments }),
    /must-not-escape-production-token|must-not-escape-raw-body/,
  );
  const recovered = await execute({
    db: harness.db,
    client,
    adapter: createProductionReadbackAdapter({
      bundleId: app.bundleId,
      marketingVersion: TARGET_VERSION,
      buildNumber: "41",
      testGroup: app.testFlightGroup,
      processed: true,
      processingStatus: "processed",
      membershipConfirmed: true,
      checkedAt: NOW,
    }),
    apps: [app],
  });

  assert.equal(recovered.status, "completed");
  assert.deepEqual(recovered.apps.map(({ id, reused }) => ({ id, reused })), [
    { id: "au", reused: true },
  ]);
  assert.deepEqual(await deploymentRows(harness.db), failedRows);
});

test("reuse audit sanitizes typed observed strings again at the persistence boundary", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const client = createClient();
  const app = CURRENT_APPS[0];
  const first = await execute({
    db: harness.db,
    client,
    adapter: createAdapter(),
    apps: [app],
  });
  assert.equal(first.status, "completed");
  const unsafeAdapter = createAdapter({
    stageFor() {
      throw new Error("reuse must not upload");
    },
    readbackFor() {
      const error = new Error("TestFlight readback evidence testGroup does not exactly match staged build");
      error.name = "TestFlightReadbackError";
      error.stage = "internal_testing";
      error.observed = {
        processed: false,
        processingStatus: "Set-Cookie: asc_session=cookie-secret; Path=/",
        testGroup: "https://alice:url-password@example.com/groups",
        membershipConfirmed: false,
      };
      throw error;
    },
  });

  const failed = await execute({
    db: harness.db,
    client,
    adapter: unsafeAdapter,
    apps: [app],
  });

  assert.equal(failed.status, "failed");
  const audit = (await deploymentRows(harness.db)).at(-1);
  assert.deepEqual(
    {
      processing_status: audit.processing_status,
      test_group: audit.test_group,
      membership_confirmed: audit.membership_confirmed,
    },
    {
      processing_status: "Set-Cookie: [REDACTED]",
      test_group: "https://[REDACTED]@example.com/groups",
      membership_confirmed: 0,
    },
  );
  assert.doesNotMatch(JSON.stringify({ failed, audit }), /cookie-secret|url-password/);
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

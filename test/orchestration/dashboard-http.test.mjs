import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { seedDashboardFixture } from "../helpers/dashboard-fixture.mjs";
import { startDashboardServer } from "../../orchestration/dashboard/http-server.mjs";

function rawRequest(port, raw) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(raw));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error("raw request timed out"));
    });
  });
}

test("orchestrator dashboard server exposes read-only JSON endpoints", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const dashboard = await startDashboardServer({
    db: harness.db,
    port: 0,
    versionListUrl: "https://app.clickup.com/space-1/v/l/version-list",
  });
  t.after(() => dashboard.close());

  const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.releasableVersions.length, 2);
  assert.equal(
    payload.releasableVersions[0].url,
    "https://app.clickup.com/space-1/v/l/version-list",
  );

  const taskResponse = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/tasks/task-1`,
  );
  assert.equal(taskResponse.status, 200);
  const task = await taskResponse.json();
  assert.equal(task.prUrl, "https://github.com/example/pr/1");

  const versionResponse = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/version-1`,
  );
  assert.equal(versionResponse.status, 200);
  const version = await versionResponse.json();
  assert.equal(version.tasks.length, 1);
  assert.deepEqual(Object.keys(version.releaseReadiness).sort(), [
    "candidateScope", "gaps", "plannedTargets", "ready", "taskIds", "taskPlatforms",
  ]);
  assert.equal(version.productionRuntimeReadiness.ready, false);

  const post = await fetch(`http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard`, {
    method: "POST",
  });
  assert.equal(post.status, 405);
  const postBody = await post.json();
  assert.deepEqual(postBody.error.details.allowed, ["GET"]);

  const missing = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/tasks/missing`,
  );
  assert.equal(missing.status, 404);

  const missingVersion = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/missing`,
  );
  assert.equal(missingVersion.status, 404);

  const malformed = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/tasks/%`,
  );
  assert.equal(malformed.status, 400);
  const malformedBody = await malformed.json();
  assert.equal(malformedBody.error.code, "INVALID_PATH");
});

test("orchestrator dashboard server enqueues a publish mutation when releasable", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  const mutationSecret = "dashboard-http-test-secret";

  const dashboard = await startDashboardServer({
    db: harness.db,
    port: 0,
    mutationSecret,
    versionListUrl: "https://app.clickup.com/space-1/v/l/version-list",
    versionStatusMap: {
      规划中: "planning",
      进行中: "active",
      发布中: "releasing",
      发布失败: "release_failed",
      已发布: "published",
      已取消: "canceled",
    },
    productionReadiness: { ready: true, error: null },
  });
  t.after(() => dashboard.close());

  const version = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/version-1`,
  );
  assert.equal(version.status, 200);
  const versionBody = await version.json();
  assert.equal(versionBody.releasable, true);
  assert.equal(JSON.stringify(versionBody).includes(mutationSecret), false);

  const unauthorized = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/version-1/publish`,
    { method: "POST" },
  );
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, "UNAUTHORIZED");
  const unauthorizedMutation = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM outbox_mutations WHERE object_id = ?")
    .bind("version-1")
    .first();
  assert.equal(unauthorizedMutation.count, 0);

  const publish = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/version-1/publish`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${mutationSecret}`, "content-type": "application/json", "x-orchestration-actor-roles": '["release_manager"]' },
      body: JSON.stringify({ confirmationVersion: "1.0.1", requestId: "request-1" }),
    },
  );
  assert.equal(publish.status, 200);
  assert.deepEqual(await publish.json(), { ok: true, status: "releasing", requestId: "request-1" });
  const mutation = await harness.db
    .prepare("SELECT target, expected_before FROM outbox_mutations WHERE object_id = ? AND field = 'status'")
    .bind("version-1")
    .first();
  assert.ok(mutation);
  assert.deepEqual(JSON.parse(mutation.target), "发布中");
  assert.deepEqual(JSON.parse(mutation.expected_before), "active");

  const notReady = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/version-2/publish`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${mutationSecret}`, "content-type": "application/json", "x-orchestration-actor-roles": '["release_manager"]' },
      body: JSON.stringify({ confirmationVersion: "1.0.2", requestId: "not-ready-request" }),
    },
  );
  assert.equal(notReady.status, 409);
  const notReadyBody = await notReady.json();
  assert.equal(notReadyBody.error.code, "NOT_RELEASABLE");

  const method = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/version-1/publish`,
  );
  assert.equal(method.status, 405);
  const methodBody = await method.json();
  assert.deepEqual(methodBody.error.details.allowed, ["POST"]);
});

test("publish confirmation is role-bound, exact, and idempotent", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  const common = {
    db: harness.db, port: 0, mutationSecret: "confirmation-secret",
    versionStatusMap: { 发布中: "releasing" }, productionReadiness: { ready: true },
  };
  const denied = await startDashboardServer(common);
  let response = await fetch(`http://127.0.0.1:${denied.port}/api/orchestration/dashboard/versions/version-1/publish`, {
    method: "POST", headers: { authorization: "Bearer confirmation-secret", "content-type": "application/json", "x-orchestration-actor-roles": '["viewer"]' },
    body: JSON.stringify({ confirmationVersion: "1.0.1", requestId: "same-request" }),
  });
  assert.equal(response.status, 403);
  await denied.close();

  const allowed = await startDashboardServer(common);
  t.after(() => allowed.close());
  response = await fetch(`http://127.0.0.1:${allowed.port}/api/orchestration/dashboard/versions/version-1/publish`, {
    method: "POST", headers: { authorization: "Bearer confirmation-secret", "content-type": "application/json", "x-orchestration-actor-roles": '["admin"]' },
    body: JSON.stringify({ confirmationVersion: "1.0.2", requestId: "same-request" }),
  });
  assert.equal(response.status, 409);
  for (let index = 0; index < 2; index += 1) {
    response = await fetch(`http://127.0.0.1:${allowed.port}/api/orchestration/dashboard/versions/version-1/publish`, {
      method: "POST", headers: { authorization: "Bearer confirmation-secret", "content-type": "application/json", "x-orchestration-actor-roles": '["admin"]' },
      body: JSON.stringify({ confirmationVersion: "1.0.1", requestId: "same-request" }),
    });
    assert.equal(response.status, 200);
  }
  const row = await harness.db.prepare("SELECT COUNT(*) AS count FROM outbox_mutations WHERE object_id = 'version-1'").first();
  assert.equal(row.count, 1);
  await harness.db.exec("UPDATE outbox_mutations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE object_id = 'version-1'");
  response = await fetch(`http://127.0.0.1:${allowed.port}/api/orchestration/dashboard/versions/version-1/publish`, {
    method: "POST", headers: { authorization: "Bearer confirmation-secret", "content-type": "application/json", "x-orchestration-actor-roles": '["admin"]' },
    body: JSON.stringify({ confirmationVersion: "1.0.1", requestId: "same-request" }),
  });
  assert.equal(response.status, 409);
  await harness.db.exec("UPDATE outbox_mutations SET status = 'confirmed' WHERE object_id = 'version-1'; UPDATE orchestration_aggregates SET state = 'releasing' WHERE aggregate_type = 'version' AND aggregate_id = 'version-1';");
  response = await fetch(`http://127.0.0.1:${allowed.port}/api/orchestration/dashboard/versions/version-1/publish`, {
    method: "POST", headers: { authorization: "Bearer confirmation-secret", "content-type": "application/json", "x-orchestration-actor-roles": '["admin"]' },
    body: JSON.stringify({ confirmationVersion: "1.0.1", requestId: "same-request" }),
  });
  assert.equal(response.status, 200);
});

test("publish rejects unsupported task platforms before enqueue", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  const snapshotRow = await harness.db.prepare("SELECT snapshot FROM clickup_snapshots WHERE object_type = 'task' AND object_id = 'task-1'").first();
  const snapshot = JSON.parse(snapshotRow.snapshot);
  snapshot.platforms = ["web", "android"];
  await harness.db.prepare("UPDATE clickup_snapshots SET snapshot = ? WHERE object_type = 'task' AND object_id = 'task-1'").bind(JSON.stringify(snapshot)).run();
  const dashboard = await startDashboardServer({
    db: harness.db, port: 0, mutationSecret: "platform-secret",
    versionStatusMap: { 发布中: "releasing" }, productionReadiness: { ready: true },
  });
  t.after(() => dashboard.close());
  const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/version-1/publish`, {
    method: "POST", headers: { authorization: "Bearer platform-secret", "content-type": "application/json", "x-orchestration-actor-roles": '["admin"]' },
    body: JSON.stringify({ confirmationVersion: "1.0.1", requestId: "platform-request" }),
  });
  assert.equal(response.status, 409);
  assert.equal((await harness.db.prepare("SELECT COUNT(*) AS count FROM outbox_mutations").first()).count, 0);
});

test("publish rejects an open task blocker and preserves expected prior status", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  await harness.db.prepare("INSERT INTO blockers (id, object_type, object_id, type, reason, status, created_at) VALUES ('release-blocker', 'task', 'task-1', 'blocked', 'hold', 'open', ?)").bind("2026-08-06T08:00:00.000Z").run();
  const dashboard = await startDashboardServer({ db: harness.db, port: 0, mutationSecret: "blocker-secret", versionStatusMap: { 发布中: "releasing" }, productionReadiness: { ready: true } });
  t.after(() => dashboard.close());
  const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/version-1/publish`, {
    method: "POST", headers: { authorization: "Bearer blocker-secret", "content-type": "application/json", "x-orchestration-actor-roles": '["admin"]' },
    body: JSON.stringify({ confirmationVersion: "1.0.1", requestId: "blocked-request" }),
  });
  assert.equal(response.status, 409);
  assert.equal((await harness.db.prepare("SELECT COUNT(*) AS count FROM outbox_mutations").first()).count, 0);
});

test("dashboard exposes production readiness and rejects publish before enqueue when runtime is invalid", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  const dashboard = await startDashboardServer({
    db: harness.db,
    port: 0,
    mutationSecret: "runtime-readiness-secret",
    versionStatusMap: { 发布中: "releasing" },
    productionReadiness: { ready: false, error: "productionConfigPath is required" },
  });
  t.after(() => dashboard.close());

  const state = await fetch(`http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard`);
  assert.deepEqual((await state.json()).productionReleaseReadiness, {
    ready: false,
    error: "productionConfigPath is required",
  });
  const publish = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/version-1/publish`,
    { method: "POST", headers: { authorization: "Bearer runtime-readiness-secret", "content-type": "application/json", "x-orchestration-actor-roles": '["admin"]' }, body: JSON.stringify({ confirmationVersion: "1.0.1", requestId: "runtime-request" }) },
  );
  assert.equal(publish.status, 503);
  assert.equal((await publish.json()).error.code, "PRODUCTION_RUNTIME_NOT_READY");
  const row = await harness.db.prepare("SELECT COUNT(*) AS count FROM outbox_mutations WHERE object_id = 'version-1'").first();
  assert.equal(row.count, 0);
});

test("version detail previews configured iOS Apps while runtime remains held and not executable", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  await harness.db.prepare("DELETE FROM release_manifests WHERE version_id='version-1'").run();
  const row = await harness.db.prepare("SELECT snapshot FROM clickup_snapshots WHERE object_id='task-1'").first();
  const task = JSON.parse(row.snapshot);
  task.platforms = ["ios"];
  await harness.db.prepare("UPDATE clickup_snapshots SET snapshot=? WHERE object_id='task-1'").bind(JSON.stringify(task)).run();
  const server = await startDashboardServer({
    db: harness.db, port: 0,
    productionReadiness: { ready: false, held: true, error: "productionConfigPath does not exist" },
    productionTargetApps: [{ id: "au", name: "AU", enabled: true, appStoreAppId: "1", scheme: "AU", bundleId: "example.au" }],
  });
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.port}/api/orchestration/dashboard/versions/version-1`);
  const detail = await response.json();
  assert.equal(response.status, 200);
  assert.equal(detail.releaseTargets[0].appId, "au");
  assert.equal(detail.releaseReadiness.gaps.some((gap) => gap.includes("iOS 生产目标注册表为空")), false);
});

test("publish re-probes lazy adapter factories before enqueueing ClickUp releasing", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  let probes = 0;
  const dashboard = await startDashboardServer({
    db: harness.db,
    port: 0,
    mutationSecret: "factory-readiness-secret",
    versionStatusMap: { 发布中: "releasing" },
    productionReadiness: async () => {
      probes += 1;
      return { ready: false, error: "production runtime adapter unavailable" };
    },
  });
  t.after(() => dashboard.close());

  const publish = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/version-1/publish`,
    { method: "POST", headers: { authorization: "Bearer factory-readiness-secret", "content-type": "application/json", "x-orchestration-actor-roles": '["admin"]' }, body: JSON.stringify({ confirmationVersion: "1.0.1", requestId: "factory-request" }) },
  );
  assert.equal(publish.status, 503);
  assert.equal(probes, 1);
  const row = await harness.db.prepare("SELECT COUNT(*) AS count FROM outbox_mutations WHERE object_id = 'version-1'").first();
  assert.equal(row.count, 0);
});

test("publish fails closed when no production readiness probe was configured", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  const dashboard = await startDashboardServer({
    db: harness.db, port: 0, mutationSecret: "missing-probe-secret",
    versionStatusMap: { 发布中: "releasing" },
  });
  t.after(() => dashboard.close());
  const publish = await fetch(
    `http://127.0.0.1:${dashboard.port}/api/orchestration/dashboard/versions/version-1/publish`,
    { method: "POST", headers: { authorization: "Bearer missing-probe-secret", "content-type": "application/json", "x-orchestration-actor-roles": '["admin"]' }, body: JSON.stringify({ confirmationVersion: "1.0.1", requestId: "probe-request" }) },
  );
  assert.equal(publish.status, 503);
  assert.match((await publish.json()).error.message, /readiness probe was not configured/);
});

test("invalid absolute-form request targets still receive a 500 response", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const dashboard = await startDashboardServer({ db: harness.db, port: 0 });
  t.after(() => dashboard.close());

  const raw = await rawRequest(
    dashboard.port,
    "GET http://[bad/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
  );
  assert.match(raw, /HTTP\/1\.1 500/);
  assert.match(raw, /INTERNAL_ERROR/);
});

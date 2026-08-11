import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTaskboardServer } from "../server/index.mjs";
import { createCloudWorkerHarness } from "./helpers/cloud-worker-harness.mjs";
import { seedDashboardFixture } from "./helpers/dashboard-fixture.mjs";
import { startDashboardServer } from "../orchestration/dashboard/http-server.mjs";

async function findClosedPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
    probe.once("error", reject);
  });
}

async function startStalledUpstream() {
  return new Promise((resolve, reject) => {
    const upstream = createHttpServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"partial":');
      response.destroy();
    });
    upstream.listen(0, "127.0.0.1", () => {
      resolve({
        port: upstream.address().port,
        close: () => new Promise((done) => upstream.close(done)),
      });
    });
    upstream.once("error", reject);
  });
}

test("server proxies orchestration dashboard to the local orchestrator", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const dashboard = await startDashboardServer({ db: harness.db, port: 0 });
  t.after(() => dashboard.close());

  const directory = await mkdtemp(path.join(os.tmpdir(), "dashboard-proxy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = createTaskboardServer({
    dataDirectory: directory,
    orchestrationPort: dashboard.port,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/api/orchestration/dashboard`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.releasableVersions[0].name, "1.0.1");

  const taskResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/orchestration/dashboard/tasks/task-1`,
  );
  assert.equal(taskResponse.status, 200);
  const task = await taskResponse.json();
  assert.equal(task.prUrl, "https://github.com/example/pr/1");

  const post = await fetch(`http://127.0.0.1:${address.port}/api/orchestration/dashboard`, {
    method: "POST",
  });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
});

test("server forwards the authenticated local release role to the protected publish endpoint", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);
  const secret = "proxy-release-secret";
  const dashboard = await startDashboardServer({
    db: harness.db, port: 0, mutationSecret: secret, productionReadiness: { ready: true },
    versionStatusMap: { 发布中: "releasing" },
  });
  t.after(() => dashboard.close());
  const directory = await mkdtemp(path.join(os.tmpdir(), "dashboard-proxy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = createTaskboardServer({ dataDirectory: directory, orchestrationPort: dashboard.port, orchestrationMutationSecret: secret });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${address.port}/api/orchestration/dashboard/versions/version-1/publish`, {
    method: "POST", headers: {
      "content-type": "application/json",
      "x-taskboard-user-id": "local-user",
      "x-taskboard-user-name": encodeURIComponent("本地用户"),
    },
    body: JSON.stringify({ confirmationVersion: "1.0.1", requestId: "proxy-request" }),
  });
  assert.equal(response.status, 200);
  const mutation = await harness.db.prepare("SELECT expected_before, actor FROM outbox_mutations WHERE id = 'publish-version-1-proxy-request'").first();
  assert.equal(JSON.parse(mutation.expected_before), "active");
  assert.equal(mutation.actor, "local-user");
});

test("server returns 503 when the orchestrator dashboard is not running", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dashboard-proxy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const closedPort = await findClosedPort();
  const app = createTaskboardServer({
    dataDirectory: directory,
    orchestrationPort: closedPort,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/api/orchestration/dashboard`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "ORCHESTRATOR_UNAVAILABLE");
});

test("server maps upstream body-read failures to 503", async (t) => {
  const stalled = await startStalledUpstream();
  t.after(() => stalled.close());

  const directory = await mkdtemp(path.join(os.tmpdir(), "dashboard-proxy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = createTaskboardServer({
    dataDirectory: directory,
    orchestrationPort: stalled.port,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/api/orchestration/dashboard`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "ORCHESTRATOR_UNAVAILABLE");
});

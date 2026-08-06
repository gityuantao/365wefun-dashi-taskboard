import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

  const post = await fetch(`http://127.0.0.1:${address.port}/api/orchestration/dashboard`, {
    method: "POST",
  });
  assert.equal(post.status, 405);
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

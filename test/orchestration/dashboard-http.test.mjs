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

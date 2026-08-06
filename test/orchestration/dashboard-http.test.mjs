import assert from "node:assert/strict";
import { test } from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { seedDashboardFixture } from "../helpers/dashboard-fixture.mjs";
import { startDashboardServer } from "../../orchestration/dashboard/http-server.mjs";

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

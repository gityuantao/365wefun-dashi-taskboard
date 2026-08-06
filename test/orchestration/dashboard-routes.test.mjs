import assert from "node:assert/strict";
import { test } from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { seedDashboardFixture } from "../helpers/dashboard-fixture.mjs";

test("dashboard routes are disabled by default", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const response = await harness.request("/api/orchestration/dashboard", {
    method: "GET",
    actorName: "owner",
  });
  assert.equal(response.response.status, 404);
  assert.equal(response.body.error.code, "ORCHESTRATION_DISABLED");
});

test("dashboard routes return aggregated payload when enabled", async (t) => {
  const harness = await createCloudWorkerHarness({
    bindings: {
      ORCHESTRATION_DIAGNOSTIC_ENABLED: "true",
      CLICKUP_CONFIG: JSON.stringify({
        spaceId: "space-1",
        lists: { version: { id: "version-list" } },
      }),
    },
  });
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const response = await harness.request("/api/orchestration/dashboard", {
    method: "GET",
    actorName: "owner",
  });
  assert.equal(response.response.status, 200);
  assert.equal(response.body.versions[0].name, "1.0.1");
  assert.equal(
    response.body.releasableVersions[0].url,
    "https://app.clickup.com/space-1/v/l/version-list",
  );
});

test("task detail route returns 404 for unknown tasks and 405 for POST", async (t) => {
  const harness = await createCloudWorkerHarness({
    bindings: { ORCHESTRATION_DIAGNOSTIC_ENABLED: "true" },
  });
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const missing = await harness.request("/api/orchestration/dashboard/tasks/missing", {
    method: "GET",
    actorName: "owner",
  });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, "NOT_FOUND");

  const post = await harness.request("/api/orchestration/dashboard", {
    method: "POST",
    actorName: "owner",
  });
  assert.equal(post.response.status, 405);
  assert.deepEqual(post.body.error.details.allowed, ["GET"]);
});

test("task detail and version detail routes return payloads and reject bad ids", async (t) => {
  const harness = await createCloudWorkerHarness({
    bindings: { ORCHESTRATION_DIAGNOSTIC_ENABLED: "true" },
  });
  t.after(() => harness.dispose());
  await seedDashboardFixture(harness.db);

  const task = await harness.request("/api/orchestration/dashboard/tasks/task-1", {
    method: "GET",
    actorName: "owner",
  });
  assert.equal(task.response.status, 200);
  assert.equal(task.body.prUrl, "https://github.com/example/pr/1");

  const version = await harness.request("/api/orchestration/dashboard/versions/version-1", {
    method: "GET",
    actorName: "owner",
  });
  assert.equal(version.response.status, 200);
  assert.equal(version.body.tasks.length, 1);

  const missingVersion = await harness.request("/api/orchestration/dashboard/versions/missing", {
    method: "GET",
    actorName: "owner",
  });
  assert.equal(missingVersion.response.status, 404);
  assert.equal(missingVersion.body.error.code, "NOT_FOUND");

  const malformed = await harness.request("/api/orchestration/dashboard/tasks/%", {
    method: "GET",
    actorName: "owner",
  });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.error.code, "INVALID_PATH");
});

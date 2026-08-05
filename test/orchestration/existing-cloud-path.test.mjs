import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";

test("existing project and task path remains operational", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const project = await harness.request("/api/projects", {
    method: "POST",
    actorName: "owner",
    json: {
      id: "baseline",
      name: "Baseline",
      workspacePath: "/tmp/baseline",
    },
  });
  assert.equal(project.response.status, 201);
  const task = await harness.request("/api/tasks", {
    method: "POST",
    actorName: "owner",
    json: {
      projectId: "baseline",
      title: "Keep current path",
      description: "",
      status: "backlog",
    },
  });
  assert.equal(task.response.status, 201);
  assert.equal(task.body.task.status, "backlog");
});

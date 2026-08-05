import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import {
  claimJob,
  completeJob,
  enqueueJob,
} from "../../orchestration/persistence/d1-runner-jobs.mjs";

const NOW = "2026-08-04T00:00:30.000Z";

async function seedJob(harness, overrides = {}) {
  await enqueueJob(harness.db, {
    jobId: "job-1",
    commandId: "cmd-1",
    jobType: "analyze",
    payload: { taskId: "task-1" },
    payloadHash: "hash-1",
    expiresAt: "2026-08-04T00:05:00.000Z",
    createdAt: NOW,
    ...overrides,
  });
}

test("claimJob claims a queued job with a fencing token", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedJob(harness);
  const job = await claimJob(harness.db, { deviceId: "device-1", jobType: "analyze", now: NOW });
  assert.equal(job.id, "job-1");
  assert.equal(job.commandId, "cmd-1");
  assert.deepEqual(job.payload, { taskId: "task-1" });
  assert.equal(job.fencingToken, 1);
  const row = await harness.db
    .prepare("SELECT status, device_id, fencing_token FROM runner_jobs WHERE id = ?")
    .bind("job-1")
    .first();
  assert.equal(row.status, "claimed");
  assert.equal(row.device_id, "device-1");
  assert.equal(row.fencing_token, 1);
});

test("claimJob does not hand a live claimed job to another device", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedJob(harness);
  await claimJob(harness.db, { deviceId: "device-1", jobType: "analyze", now: NOW });
  const second = await claimJob(harness.db, { deviceId: "device-2", jobType: "analyze", now: NOW });
  assert.equal(second, null);
});

test("claimJob allows a new device to take over an expired lease", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedJob(harness, { expiresAt: "2026-08-04T00:00:20.000Z" });
  await claimJob(harness.db, { deviceId: "device-1", jobType: "analyze", now: NOW });
  const takeover = await claimJob(harness.db, {
    deviceId: "device-2",
    jobType: "analyze",
    now: "2026-08-04T00:16:00.000Z",
  });
  assert.equal(takeover.id, "job-1");
  assert.equal(takeover.fencingToken, 2);
});

test("completeJob validates the claimant and fencing token", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedJob(harness);
  await claimJob(harness.db, { deviceId: "device-1", jobType: "analyze", now: NOW });
  await assert.rejects(
    completeJob(harness.db, {
      jobId: "job-1",
      deviceId: "device-2",
      fencingToken: 1,
      status: "completed",
      result: {},
      now: NOW,
    }),
    /CLAIM_MISMATCH/,
  );
  await assert.rejects(
    completeJob(harness.db, {
      jobId: "job-1",
      deviceId: "device-1",
      fencingToken: 99,
      status: "completed",
      result: {},
      now: NOW,
    }),
    /CLAIM_MISMATCH/,
  );
  const completed = await completeJob(harness.db, {
    jobId: "job-1",
    deviceId: "device-1",
    fencingToken: 1,
    status: "completed",
    result: { ok: true },
    now: NOW,
  });
  assert.equal(completed.status, "completed");
  const row = await harness.db
    .prepare("SELECT status, result FROM runner_jobs WHERE id = ?")
    .bind("job-1")
    .first();
  assert.equal(row.status, "completed");
  assert.deepEqual(JSON.parse(row.result), { ok: true });
});

test("runner API exposes claim and result routes", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedJob(harness);
  const claim = await harness.request("/api/runner/jobs/next?device_id=device-api&job_type=analyze", {
    method: "GET",
    actorName: "runner",
  });
  assert.equal(claim.response.status, 200);
  assert.equal(claim.body.job.id, "job-1");
  assert.equal(claim.body.job.fencingToken, 1);

  const result = await harness.request("/api/runner/jobs/job-1/result", {
    method: "POST",
    actorName: "runner",
    json: {
      deviceId: "device-api",
      fencingToken: 1,
      status: "completed",
      result: { summary: "ok" },
    },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.status, "completed");
});

test("runner API rejects stale claims on result", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await seedJob(harness);
  await harness.request("/api/runner/jobs/next?device_id=device-a&job_type=analyze", {
    method: "GET",
    actorName: "runner",
  });
  const stale = await harness.request("/api/runner/jobs/job-1/result", {
    method: "POST",
    actorName: "runner",
    json: {
      deviceId: "device-b",
      fencingToken: 1,
      status: "completed",
      result: {},
    },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "CLAIM_MISMATCH");
});

test("runner API returns 204 when no job is available", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const claim = await harness.request("/api/runner/jobs/next?device_id=device-a&job_type=analyze", {
    method: "GET",
    actorName: "runner",
  });
  assert.equal(claim.response.status, 204);
});

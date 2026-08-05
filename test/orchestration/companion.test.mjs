import assert from "node:assert/strict";
import test from "node:test";
import { runCompanionOnce } from "../../orchestration/runner/companion.mjs";

function jsonResponse(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const JOB = {
  id: "job-1",
  commandId: "cmd-1",
  jobType: "analyze",
  payload: { taskId: "task-1" },
  payloadHash: "hash-1",
  fencingToken: 1,
  expiresAt: "2026-08-04T00:15:00.000Z",
};

test("companion reports no claim when the queue is empty", async () => {
  const fetchImpl = async () => jsonResponse(204);
  const result = await runCompanionOnce({
    apiUrl: "http://127.0.0.1:47823",
    deviceId: "device-1",
    jobType: "analyze",
    handlers: {},
    fetchImpl,
  });
  assert.deepEqual(result, { claimed: false });
});

test("companion claims a job, runs the handler, and posts a completed result", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === "POST") return jsonResponse(200, { status: "completed" });
    return jsonResponse(200, { job: JOB });
  };
  const result = await runCompanionOnce({
    apiUrl: "http://127.0.0.1:47823",
    deviceId: "device-1",
    jobType: "analyze",
    handlers: {
      analyze: async (job) => ({ summary: `analyzed ${job.payload.taskId}` }),
    },
    fetchImpl,
  });
  assert.deepEqual(result, { claimed: true, jobId: "job-1", status: "completed" });
  assert.ok(calls[0].url.includes("device_id=device-1"));
  assert.ok(calls[0].url.includes("job_type=analyze"));
  assert.ok(calls[1].url.endsWith("/api/runner/jobs/job-1/result"));
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    deviceId: "device-1",
    fencingToken: 1,
    status: "completed",
    result: { summary: "analyzed task-1" },
  });
});

test("companion posts a failed result when the handler throws", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === "POST") return jsonResponse(200, { status: "failed" });
    return jsonResponse(200, { job: JOB });
  };
  const result = await runCompanionOnce({
    apiUrl: "http://127.0.0.1:47823",
    deviceId: "device-1",
    jobType: "analyze",
    handlers: {
      analyze: async () => { throw new Error("boom"); },
    },
    fetchImpl,
  });
  assert.deepEqual(result, { claimed: true, jobId: "job-1", status: "failed" });
  const posted = JSON.parse(calls[1].init.body);
  assert.equal(posted.status, "failed");
  assert.match(posted.result.error, /boom/);
});

test("companion surfaces a failed result post", async () => {
  const fetchImpl = async (url, init = {}) => {
    if (init.method === "POST") return jsonResponse(500, { err: "server" });
    return jsonResponse(200, { job: JOB });
  };
  await assert.rejects(
    runCompanionOnce({
      apiUrl: "http://127.0.0.1:47823",
      deviceId: "device-1",
      jobType: "analyze",
      handlers: { analyze: async () => ({}) },
      fetchImpl,
    }),
    /HTTP_500/,
  );
});

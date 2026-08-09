import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { enqueueJob } from "../../orchestration/persistence/d1-runner-jobs.mjs";
import { recoverExpiredRunnerJobsOnTick } from "../../orchestration/runner/tick-recovery.mjs";

test("each orchestrator tick requeues an expired claimed job", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await enqueueJob(harness.db, {
    jobId: "stuck-develop",
    commandId: "cmd-stuck",
    jobType: "develop",
    payload: { taskId: "task-stuck" },
    payloadHash: "hash-stuck",
    expiresAt: "2026-08-09T16:00:00.000Z",
    createdAt: "2026-08-09T15:00:00.000Z",
  });
  await harness.db.prepare(
    `UPDATE runner_jobs
     SET status = 'claimed', device_id = 'dead-runner', fencing_token = 1,
         claimed_at = '2026-08-09T15:00:00.000Z', expires_at = '2026-08-09T16:00:00.000Z'
     WHERE id = 'stuck-develop'`,
  ).run();

  const recovered = await recoverExpiredRunnerJobsOnTick(harness.db, {
    now: "2026-08-09T16:00:01.000Z",
  });

  assert.equal(recovered.requeued, 1);
  const row = await harness.db.prepare(
    "SELECT status, device_id FROM runner_jobs WHERE id = 'stuck-develop'",
  ).first();
  assert.deepEqual(row, { status: "queued", device_id: null });
});

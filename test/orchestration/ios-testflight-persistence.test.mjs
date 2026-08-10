import assert from "node:assert/strict";
import test from "node:test";

import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";

const INSERT_DEPLOYMENT = `
  INSERT INTO ios_testflight_deployments (
    task_id, candidate_commit, app_id, attempt, scheme, bundle_id,
    marketing_version, build_number, upload_id, processing_status,
    test_group, membership_confirmed, stage, status, error, started_at, completed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const findReusableSuccess = (db, {
  taskId,
  candidateCommit,
  appId,
  marketingVersion,
}) => db.prepare(`
  SELECT attempt, upload_id
  FROM ios_testflight_deployments
  WHERE task_id = ?
    AND candidate_commit = ?
    AND app_id = ?
    AND marketing_version = ?
    AND status = 'succeeded'
    AND processing_status = 'processed'
    AND membership_confirmed = 1
  ORDER BY attempt DESC
  LIMIT 1
`).bind(taskId, candidateCommit, appId, marketingVersion).first();

function deployment({
  taskId = "task-1",
  candidateCommit = "candidate-a",
  appId = "au",
  attempt = 1,
  marketingVersion = "1.2.3",
  processingStatus = "processed",
  membershipConfirmed = 1,
  stage = "complete",
  status = "succeeded",
  uploadId = `upload-${attempt}`,
} = {}) {
  return [
    taskId,
    candidateCommit,
    appId,
    attempt,
    "E365AU",
    "online.365english.app",
    marketingVersion,
    "42",
    uploadId,
    processingStatus,
    "Internal Testing",
    membershipConfirmed,
    stage,
    status,
    null,
    "2026-08-10T00:00:00.000Z",
    "2026-08-10T00:01:00.000Z",
  ];
}

test("TestFlight evidence rejects duplicate attempts and invalid lifecycle values", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());

  await harness.db.prepare(INSERT_DEPLOYMENT).bind(...deployment()).run();

  await assert.rejects(
    harness.db.prepare(INSERT_DEPLOYMENT).bind(...deployment()).run(),
    /UNIQUE constraint failed/i,
  );
  await assert.rejects(
    harness.db.prepare(INSERT_DEPLOYMENT).bind(...deployment({ attempt: 2, status: "waiting" })).run(),
    /CHECK constraint failed/i,
  );
  await assert.rejects(
    harness.db.prepare(INSERT_DEPLOYMENT).bind(...deployment({ attempt: 2, stage: "handoff" })).run(),
    /CHECK constraint failed/i,
  );
});

test("only a matching processed and confirmed TestFlight success is reusable", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());

  await harness.db.prepare(INSERT_DEPLOYMENT).bind(...deployment()).run();
  await harness.db.prepare(INSERT_DEPLOYMENT).bind(...deployment({ attempt: 2, marketingVersion: "1.2.4" })).run();
  await harness.db.prepare(INSERT_DEPLOYMENT).bind(...deployment({ attempt: 3, processingStatus: "processing" })).run();
  await harness.db.prepare(INSERT_DEPLOYMENT).bind(...deployment({ attempt: 4, membershipConfirmed: 0 })).run();
  await harness.db.prepare(INSERT_DEPLOYMENT).bind(...deployment({ taskId: "task-2", attempt: 5 })).run();
  await harness.db.prepare(INSERT_DEPLOYMENT).bind(...deployment({ candidateCommit: "candidate-b", attempt: 6 })).run();
  await harness.db.prepare(INSERT_DEPLOYMENT).bind(...deployment({ appId: "cn", attempt: 7 })).run();

  assert.deepEqual(
    await findReusableSuccess(harness.db, {
      taskId: "task-1",
      candidateCommit: "candidate-a",
      appId: "au",
      marketingVersion: "1.2.3",
    }),
    { attempt: 1, upload_id: "upload-1" },
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";

test("iOS TestFlight migration creates per-App evidence with a unique attempt key and latest lookup indexes", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());

  const columns = (await harness.db
    .prepare("PRAGMA table_info(ios_testflight_deployments)")
    .all()).results;

  assert.deepEqual(
    columns.map(({ name }) => name),
    [
      "task_id",
      "candidate_commit",
      "app_id",
      "attempt",
      "scheme",
      "bundle_id",
      "marketing_version",
      "build_number",
      "upload_id",
      "processing_status",
      "test_group",
      "membership_confirmed",
      "stage",
      "status",
      "error",
      "started_at",
      "completed_at",
    ],
  );
  assert.deepEqual(
    columns.filter(({ pk }) => pk > 0).sort((left, right) => left.pk - right.pk).map(({ name }) => name),
    ["task_id", "candidate_commit", "app_id", "attempt"],
  );

  const indexes = (await harness.db
    .prepare("PRAGMA index_list(ios_testflight_deployments)")
    .all()).results;
  assert.deepEqual(
    indexes.map(({ name }) => name).sort(),
    [
      "idx_ios_testflight_deployments_latest",
      "idx_ios_testflight_deployments_reusable_success",
      "sqlite_autoindex_ios_testflight_deployments_1",
    ],
  );
});

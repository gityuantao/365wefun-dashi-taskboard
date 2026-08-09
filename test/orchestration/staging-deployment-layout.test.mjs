import assert from "node:assert/strict";
import test from "node:test";

import {
  stagingProbeUrls,
  stagingReleaseRootMode,
  stagingRsyncArgs,
} from "../../orchestration/release/staging-deployment-layout.mjs";

test("staging rsync keeps release directories traversable by nginx", () => {
  const args = stagingRsyncArgs({
    worktree: "/tmp/candidate",
    host: "root@example.test",
    releasePath: "/opt/e365-staging/releases/release-1",
  });

  assert.ok(args.includes("--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r"));
});

test("staging explicitly fixes the pre-created release root mode", () => {
  assert.equal(stagingReleaseRootMode(), "0755");
});

test("staging readiness covers API, public web, and admin web", () => {
  assert.deepEqual(stagingProbeUrls(), [
    "https://test-api.365english.online/health/ready",
    "https://test-au.365english.online/",
    "https://test-admin.365english.online/",
  ]);
});

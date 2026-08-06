import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startDashboardServer } from "../../orchestration/dashboard/http-server.mjs";

test("control endpoints read and update the master switch", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "control-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const controlPath = path.join(dir, "control.json");

  const server = await startDashboardServer({ db: null, port: 0, controlPath });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  const initial = await fetch(`${base}/api/orchestration/control`);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).enabled, true);

  const updated = await fetch(`${base}/api/orchestration/control`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).enabled, false);

  const bad = await fetch(`${base}/api/orchestration/control`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: "yes" }),
  });
  assert.equal(bad.status, 400);

  const post = await fetch(`${base}/api/orchestration/control`, { method: "POST" });
  assert.equal(post.status, 405);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTaskboardServer } from "../server/index.mjs";
import { startDashboardServer } from "../orchestration/dashboard/http-server.mjs";

test("server proxies control GET and PUT to the local orchestrator", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "control-proxy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const controlPath = path.join(dir, "control.json");
  const dashboard = await startDashboardServer({ db: null, port: 0, controlPath });
  t.after(() => dashboard.close());

  const app = createTaskboardServer({
    dataDirectory: path.join(dir, "app"),
    orchestrationPort: dashboard.port,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;

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

  const post = await fetch(`${base}/api/orchestration/control`, { method: "POST" });
  assert.equal(post.status, 405);
});

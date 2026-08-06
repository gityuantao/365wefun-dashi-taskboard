import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  readControl,
  shouldProcess,
  writeControl,
} from "../../orchestration/control.mjs";

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orchestration-control-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("missing control file defaults to enabled", async (t) => {
  const dir = await tempDir(t);
  const control = await readControl(path.join(dir, "control.json"));
  assert.deepEqual(control, { enabled: true, updatedAt: null });
  assert.equal(shouldProcess(control), true);
});

test("writeControl persists enabled state and updates the timestamp", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "control.json");
  const written = await writeControl(file, { enabled: false });
  assert.equal(written.enabled, false);
  assert.equal(typeof written.updatedAt, "string");

  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.equal(raw.enabled, false);
  assert.equal(raw.updatedAt, written.updatedAt);

  const read = await readControl(file);
  assert.equal(read.enabled, false);
  assert.equal(read.updatedAt, written.updatedAt);
  assert.equal(shouldProcess(read), false);
});

test("readControl normalizes malformed files to disabled", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "control.json");
  await writeFile(file, "not json", "utf8");
  const control = await readControl(file);
  assert.equal(control.enabled, false);
});

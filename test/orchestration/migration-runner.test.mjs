import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { applyMigrations } from "../../orchestration/persistence/migrations.mjs";
import { loadCleanupAttempts } from "../../orchestration/application/release-commands.mjs";

const MIGRATIONS_DIR = path.resolve("cloud/migrations");

test("migration ledger applies 0008 and adopts staging failure ownership on an existing DB", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await harness.db.exec("DROP TABLE release_cleanup_attempts");
  assert.ok(await harness.db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'projects'")
    .first());

  const names = (await readdir(MIGRATIONS_DIR))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  const migrations = await Promise.all(names.map(async (name) => ({
    name,
    sql: await readFile(path.join(MIGRATIONS_DIR, name), "utf8"),
  })));
  const result = await applyMigrations({ db: harness.db, migrations, now: "2026-08-09T00:00:00.000Z" });

  assert.ok(result.applied.includes("0008_release_cleanup_attempts.sql"));
  assert.ok(result.adopted.includes("0012_staging_failure_ownership.sql"));
  assert.ok(result.adopted.includes("0013_production_release_attempts.sql"));
  assert.deepEqual(await loadCleanupAttempts({
    db: harness.db,
    versionId: "version-1",
    candidateCommit: "1111111111111111111111111111111111111111",
    taskId: "task-a",
  }), []);
  const ledger = await harness.db.prepare("SELECT name FROM orchestration_migrations ORDER BY name").all();
  assert.equal(ledger.results.length, names.length);
});

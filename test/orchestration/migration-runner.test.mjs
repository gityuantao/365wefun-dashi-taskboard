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

test("migration ledger fails closed for a partial production release schema", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await harness.db.exec("DROP TABLE production_release_targets;");
  const migrations = [{
    name: "0013_production_release_attempts.sql",
    sql: await readFile(path.join(MIGRATIONS_DIR, "0013_production_release_attempts.sql"), "utf8"),
  }];

  await assert.rejects(
    () => applyMigrations({ db: harness.db, migrations, now: "2026-08-11T00:00:00.000Z" }),
    (error) => error.code === "PRODUCTION_RELEASE_SCHEMA_DRIFT",
  );
});

test("migration ledger validates an applied 0013 schema before skipping it", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await harness.db.exec("DROP TABLE production_release_targets; CREATE TABLE production_release_targets (manifest_id TEXT NOT NULL);");
  await harness.db.exec("CREATE TABLE orchestration_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL, adopted INTEGER NOT NULL CHECK (adopted IN (0, 1))); INSERT INTO orchestration_migrations (name, applied_at, adopted) VALUES ('0013_production_release_attempts.sql', '2026-08-11T00:00:00.000Z', 0);");
  const migrations = [{
    name: "0013_production_release_attempts.sql",
    sql: await readFile(path.join(MIGRATIONS_DIR, "0013_production_release_attempts.sql"), "utf8"),
  }];

  await assert.rejects(
    () => applyMigrations({ db: harness.db, migrations, now: "2026-08-11T00:00:00.000Z" }),
    (error) => error.code === "PRODUCTION_RELEASE_SCHEMA_DRIFT",
  );
});

test("migration ledger fails closed for an unrecorded legacy manifest_id schema", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await harness.db.exec("DROP TABLE production_release_targets; DROP TABLE production_release_attempts; CREATE TABLE production_release_attempts (version_id TEXT NOT NULL, candidate_commit TEXT NOT NULL, manifest_id TEXT NOT NULL); CREATE TABLE production_release_targets (version_id TEXT NOT NULL, candidate_commit TEXT NOT NULL, manifest_id TEXT NOT NULL);");
  const migrations = [{
    name: "0013_production_release_attempts.sql",
    sql: await readFile(path.join(MIGRATIONS_DIR, "0013_production_release_attempts.sql"), "utf8"),
  }];

  await assert.rejects(
    () => applyMigrations({ db: harness.db, migrations, now: "2026-08-11T00:00:00.000Z" }),
    (error) => error.code === "PRODUCTION_RELEASE_SCHEMA_DRIFT",
  );
});

test("migration ledger rejects same-name production schema objects with unsafe definitions", async (t) => {
  const setupCases = [
    "DROP INDEX idx_production_release_targets_reusable_success; CREATE INDEX idx_production_release_targets_reusable_success ON production_release_targets (attempt);",
    "DROP TRIGGER production_release_targets_immutable_succeeded_delete; CREATE TRIGGER production_release_targets_immutable_succeeded_delete BEFORE DELETE ON production_release_targets BEGIN SELECT 1; END;",
    "DROP TABLE production_release_targets; CREATE TABLE production_release_targets AS SELECT * FROM production_release_attempts;",
  ];
  for (const setup of setupCases) {
    const harness = await createCloudWorkerHarness();
    try {
      await harness.db.exec(setup);
      const migrations = [{
        name: "0013_production_release_attempts.sql",
        sql: await readFile(path.join(MIGRATIONS_DIR, "0013_production_release_attempts.sql"), "utf8"),
      }];
      await assert.rejects(
        () => applyMigrations({ db: harness.db, migrations, now: "2026-08-11T00:00:00.000Z" }),
        (error) => error.code === "PRODUCTION_RELEASE_SCHEMA_DRIFT",
      );
    } finally {
      await harness.dispose();
    }
  }
});

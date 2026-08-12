import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createCloudWorkerHarness } from "../helpers/cloud-worker-harness.mjs";
import { applyMigrations } from "../../orchestration/persistence/migrations.mjs";
import { loadCleanupAttempts } from "../../orchestration/application/release-commands.mjs";

const MIGRATIONS_DIR = path.resolve("cloud/migrations");
const PRODUCTION_MIGRATION_NAME = "0013_production_release_attempts.sql";
const ALL_PLATFORM_MIGRATION_NAME = "0015_all_platform_release_targets.sql";

async function loadProductionMigration() {
  return {
    name: PRODUCTION_MIGRATION_NAME,
    sql: await readFile(path.join(MIGRATIONS_DIR, PRODUCTION_MIGRATION_NAME), "utf8"),
  };
}

async function loadAllPlatformMigration() {
  return {
    name: ALL_PLATFORM_MIGRATION_NAME,
    sql: await readFile(path.join(MIGRATIONS_DIR, ALL_PLATFORM_MIGRATION_NAME), "utf8"),
  };
}

async function loadMigration(name) {
  return { name, sql: await readFile(path.join(MIGRATIONS_DIR, name), "utf8") };
}

test("empty production schema applies the complete 0013 through 0015 migration sequence", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await harness.db.exec("DROP TABLE production_release_targets; DROP TABLE production_release_attempts;");
  const names = [PRODUCTION_MIGRATION_NAME, "0014_mini_program_production_target.sql", ALL_PLATFORM_MIGRATION_NAME];

  assert.deepEqual(
    await applyMigrations({ db: harness.db, migrations: await Promise.all(names.map(loadMigration)) }),
    { applied: names, adopted: [] },
  );
});

test("recorded canonical 0014 upgrades through the complete ordered migration list", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await harness.db.exec("DROP TABLE production_release_targets; DROP TABLE production_release_attempts;");
  await harness.db.exec(await readFile(path.join(MIGRATIONS_DIR, PRODUCTION_MIGRATION_NAME), "utf8"));
  await harness.db.exec(await readFile(path.join(MIGRATIONS_DIR, "0014_mini_program_production_target.sql"), "utf8"));
  await harness.db.exec("CREATE TABLE orchestration_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL, adopted INTEGER NOT NULL CHECK (adopted IN (0, 1))); INSERT INTO orchestration_migrations VALUES ('0013_production_release_attempts.sql', '2026-08-12T00:00:00.000Z', 0), ('0014_mini_program_production_target.sql', '2026-08-12T00:00:00.000Z', 0);");
  const names = [PRODUCTION_MIGRATION_NAME, "0014_mini_program_production_target.sql", ALL_PLATFORM_MIGRATION_NAME];

  assert.deepEqual(
    await applyMigrations({ db: harness.db, migrations: await Promise.all(names.map(loadMigration)) }),
    { applied: [ALL_PLATFORM_MIGRATION_NAME], adopted: [] },
  );
});

async function assertProductionSchemaDrift(db, migration) {
  await assert.rejects(
    () => applyMigrations({
      db,
      migrations: [migration],
      now: "2026-08-11T00:00:00.000Z",
    }),
    (error) => error.code === "PRODUCTION_RELEASE_SCHEMA_DRIFT",
  );
}

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
  const preProductionNames = names.filter((name) => name < PRODUCTION_MIGRATION_NAME);

  assert.deepEqual(
    result.applied.filter((name) => preProductionNames.includes(name)),
    ["0008_release_cleanup_attempts.sql"],
  );
  assert.deepEqual(
    result.adopted.filter((name) => preProductionNames.includes(name)),
    preProductionNames.filter((name) => name !== "0008_release_cleanup_attempts.sql"),
  );
  assert.ok(result.adopted.includes("0012_staging_failure_ownership.sql"));
  assert.ok(result.adopted.includes(PRODUCTION_MIGRATION_NAME));
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
  const migration = await loadProductionMigration();

  await assertProductionSchemaDrift(harness.db, migration);
});

test("migration ledger validates newly applied 0013 objects before recording success", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await harness.db.exec("DROP TABLE production_release_targets; DROP TABLE production_release_attempts; CREATE TABLE production_release_trigger_carrier (id INTEGER); CREATE TRIGGER production_release_targets_immutable_succeeded_delete BEFORE DELETE ON production_release_trigger_carrier BEGIN SELECT 1; END;");
  const migration = await loadProductionMigration();

  await assertProductionSchemaDrift(harness.db, migration);
  assert.equal(
    await harness.db
      .prepare("SELECT name FROM orchestration_migrations WHERE name = ?")
      .bind(PRODUCTION_MIGRATION_NAME)
      .first(),
    null,
  );
});

test("migration ledger validates an applied 0013 schema before skipping it", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await harness.db.exec("DROP TABLE production_release_targets; CREATE TABLE production_release_targets (manifest_id TEXT NOT NULL);");
  await harness.db.exec("CREATE TABLE orchestration_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL, adopted INTEGER NOT NULL CHECK (adopted IN (0, 1))); INSERT INTO orchestration_migrations (name, applied_at, adopted) VALUES ('0013_production_release_attempts.sql', '2026-08-11T00:00:00.000Z', 0);");
  const migration = await loadProductionMigration();

  await assertProductionSchemaDrift(harness.db, migration);
});

test("migration ledger fails closed for an unrecorded legacy manifest_id schema", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await harness.db.exec("DROP TABLE production_release_targets; DROP TABLE production_release_attempts; CREATE TABLE production_release_attempts (version_id TEXT NOT NULL, candidate_commit TEXT NOT NULL, manifest_id TEXT NOT NULL); CREATE TABLE production_release_targets (version_id TEXT NOT NULL, candidate_commit TEXT NOT NULL, manifest_id TEXT NOT NULL);");
  const migration = await loadProductionMigration();

  await assertProductionSchemaDrift(harness.db, migration);
});

test("migration ledger adopts the canonical production schema", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const migration = await loadProductionMigration();

  assert.deepEqual(
    await applyMigrations({
      db: harness.db,
      migrations: [migration],
      now: "2026-08-11T00:00:00.000Z",
    }),
    { applied: [], adopted: [PRODUCTION_MIGRATION_NAME] },
  );
});

test("migration ledger identifies canonical objects by type when schema names overlap", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const migration = await loadProductionMigration();
  await harness.db.exec("DROP INDEX idx_production_release_targets_latest; CREATE TRIGGER idx_production_release_targets_latest AFTER INSERT ON production_release_targets BEGIN SELECT 1; END; CREATE INDEX idx_production_release_targets_latest ON production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt DESC);");

  assert.deepEqual(
    await applyMigrations({
      db: harness.db,
      migrations: [migration],
      now: "2026-08-11T00:00:00.000Z",
    }),
    { applied: [], adopted: [PRODUCTION_MIGRATION_NAME] },
  );
});

test("migration ledger rejects a same-column production table missing a critical CHECK", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const migration = await loadProductionMigration();
  const row = await harness.db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'production_release_targets'")
    .first();
  const checkedEvidenceColumn = "sanitized_observed_evidence TEXT CHECK (sanitized_observed_evidence IS NULL OR (length(trim(sanitized_observed_evidence)) > 0 AND length(sanitized_observed_evidence) <= 4096 AND json_valid(sanitized_observed_evidence)))";
  const unsafeDefinition = row.sql.replace(
    checkedEvidenceColumn,
    "sanitized_observed_evidence TEXT",
  );
  assert.notEqual(unsafeDefinition, row.sql);

  await harness.db.exec("DROP TABLE production_release_targets;");
  await harness.db.exec(`${unsafeDefinition};`);
  await harness.db.exec(migration.sql);

  await assertProductionSchemaDrift(harness.db, migration);
});

test("migration ledger does not normalize non-SQL Unicode whitespace into a safe definition", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const migration = await loadProductionMigration();
  const row = await harness.db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'production_release_targets'")
    .first();
  const unsafeDefinition = row.sql.replace(
    "status TEXT NOT NULL CHECK",
    "status TEXT\u00a0NOT NULL CHECK",
  );
  assert.notEqual(unsafeDefinition, row.sql);

  await harness.db.exec("DROP TABLE production_release_targets;");
  await harness.db.exec(`${unsafeDefinition};`);
  await harness.db.exec(migration.sql);
  const statusColumn = await harness.db
    .prepare("SELECT type, \"notnull\" AS is_not_null FROM pragma_table_info('production_release_targets') WHERE name = 'status'")
    .first();
  assert.deepEqual(statusColumn, { type: "TEXT\u00a0NOT", is_not_null: 0 });
  await harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, started_at, created_at, updated_at) VALUES ('v-unicode', 'candidate-unicode', 'checksum-unicode', 'web', '', 1, 'upload', NULL, '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');");

  await assertProductionSchemaDrift(harness.db, migration);
});

test("migration ledger rejects a reusable index with only the expected predicate prefix", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const migration = await loadProductionMigration();
  await harness.db.exec("DROP INDEX idx_production_release_targets_reusable_success; CREATE INDEX idx_production_release_targets_reusable_success ON production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt DESC) WHERE status = 'succeeded' AND reconciliation_status IN ('not_required', 'readback_confirmed') AND ((platform IN ('web', 'api') AND stage = 'readback') OR (platform = 'ios' AND stage = 'live_readback')); ");

  await assertProductionSchemaDrift(harness.db, migration);
});

test("migration ledger rejects a same-name empty trigger that spoofs the old fragment check", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const migration = await loadProductionMigration();
  const legacyFragment = "before delete on production_release_targets when old.status = 'succeeded' begin select raise(abort, 'immutable succeeded production release target'); end";
  await harness.db.exec(`DROP TRIGGER production_release_targets_immutable_succeeded_delete; CREATE TRIGGER production_release_targets_immutable_succeeded_delete /* ${legacyFragment} */ BEFORE DELETE ON production_release_targets BEGIN SELECT 1; END;`);
  const row = await harness.db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'production_release_targets_immutable_succeeded_delete'")
    .first();
  assert.ok(row.sql.toLowerCase().replace(/\s+/g, " ").includes(legacyFragment));

  await assertProductionSchemaDrift(harness.db, migration);
});

test("0015 all-platform sentinel rejects partial and same-name malformed schemas", async (t) => {
  const migration = await loadAllPlatformMigration();
  for (const mutation of [
    "DROP INDEX idx_production_release_targets_reusable_success",
    "DROP TRIGGER production_release_targets_immutable_succeeded_delete; CREATE TRIGGER production_release_targets_immutable_succeeded_delete BEFORE DELETE ON production_release_targets BEGIN SELECT 1; END",
  ]) {
    const harness = await createCloudWorkerHarness();
    t.after(() => harness.dispose());
    await harness.db.exec(mutation);
    await assert.rejects(
      () => applyMigrations({ db: harness.db, migrations: [migration], now: "2026-08-12T00:00:00.000Z" }),
      (error) => error.code === "PRODUCTION_RELEASE_SCHEMA_DRIFT",
    );
  }
});

test("0015 reusable-success index is the exact terminal all-platform predicate", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  const row = await harness.db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_production_release_targets_reusable_success'",
  ).first();
  assert.match(row.sql, /platform = 'mini_program'.*stage = 'live_readback'/i);
  assert.match(row.sql, /mini_program_app_id IS NOT NULL.*artifact_digest IS NOT NULL/i);
  assert.match(row.sql, /upload_id IS NOT NULL.*review_submission_id IS NOT NULL.*review_id IS NOT NULL.*release_id IS NOT NULL.*live_id IS NOT NULL/i);
  assert.match(row.sql, /platform = 'android_twa'.*stage = 'live_readback'/i);
});

test("0015 upgrades only the complete canonical 0014 schema", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await harness.db.exec("DROP TRIGGER production_release_targets_immutable_succeeded; DROP TRIGGER production_release_targets_immutable_succeeded_delete; DROP INDEX idx_production_release_targets_latest; DROP INDEX idx_production_release_targets_reusable_success; DROP TABLE production_release_targets;");
  await harness.db.exec(await readFile(path.join(MIGRATIONS_DIR, PRODUCTION_MIGRATION_NAME), "utf8"));
  await harness.db.exec(await readFile(path.join(MIGRATIONS_DIR, "0014_mini_program_production_target.sql"), "utf8"));
  const migration = await loadAllPlatformMigration();

  assert.deepEqual(
    await applyMigrations({ db: harness.db, migrations: [migration], now: "2026-08-12T00:00:00.000Z" }),
    { applied: [ALL_PLATFORM_MIGRATION_NAME], adopted: [] },
  );
  const columns = await harness.db.prepare("SELECT name FROM pragma_table_info('production_release_targets')").all();
  assert.ok(columns.results.some(({ name }) => name === "artifact_digest"));
});

test("0015 fails closed instead of dropping legacy mini-program target identity", async (t) => {
  const harness = await createCloudWorkerHarness();
  t.after(() => harness.dispose());
  await harness.db.exec("DROP TRIGGER production_release_targets_immutable_succeeded; DROP TRIGGER production_release_targets_immutable_succeeded_delete; DROP INDEX idx_production_release_targets_latest; DROP INDEX idx_production_release_targets_reusable_success; DROP TABLE production_release_targets;");
  await harness.db.exec(await readFile(path.join(MIGRATIONS_DIR, PRODUCTION_MIGRATION_NAME), "utf8"));
  await harness.db.exec(await readFile(path.join(MIGRATIONS_DIR, "0014_mini_program_production_target.sql"), "utf8"));
  await harness.db.exec("INSERT INTO production_release_targets (version_id, candidate_commit, manifest_checksum, platform, app_id, attempt, stage, status, started_at, created_at, updated_at) VALUES ('v-legacy-mp', 'candidate', 'checksum', 'mini_program', '', 1, 'preflight', 'pending', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');");
  const migration = await loadAllPlatformMigration();

  await assert.rejects(
    () => applyMigrations({ db: harness.db, migrations: [migration], now: "2026-08-12T00:00:00.000Z" }),
    /CHECK constraint failed/,
  );
  assert.deepEqual(
    await harness.db.prepare("SELECT platform, app_id FROM production_release_targets WHERE version_id = 'v-legacy-mp'").first(),
    { platform: "mini_program", app_id: "" },
  );
});

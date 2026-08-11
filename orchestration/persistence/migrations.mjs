const LEGACY_SENTINELS = new Map([
  ["0001_initial.sql", { table: "projects" }],
  ["0002_orchestration_core.sql", { table: "orchestration_commands" }],
  ["0003_clickup_snapshots.sql", { table: "clickup_snapshots" }],
  ["0004_outbox_mutations.sql", { table: "outbox_mutations" }],
  ["0005_runner_jobs.sql", { table: "runner_jobs" }],
  ["0006_failure_tracking.sql", { table: "task_rework" }],
  ["0007_release_manifests.sql", { table: "release_manifests" }],
  ["0008_release_cleanup_attempts.sql", { table: "release_cleanup_attempts" }],
  ["0009_staging_deployments.sql", { table: "staging_deployments" }],
  ["0010_ios_testflight_deployments.sql", { table: "ios_testflight_deployments" }],
  ["0011_ios_testflight_revalidation_attempts.sql", {
    table: "ios_testflight_deployments",
    column: "failure_classification",
  }],
  ["0012_staging_failure_ownership.sql", {
    table: "staging_deployments",
    column: "failure_owner",
  }],
  ["0013_production_release_attempts.sql", { check: hasCompleteProductionReleaseSchema }],
]);

async function hasCompleteProductionReleaseSchema(db) {
  const tables = ["production_release_attempts", "production_release_targets"];
  const indexes = [
    "idx_production_release_targets_latest",
    "idx_production_release_targets_reusable_success",
  ];
  const triggers = [
    "production_release_attempts_immutable_succeeded",
    "production_release_targets_immutable_succeeded",
    "production_release_attempts_immutable_succeeded_delete",
    "production_release_targets_immutable_succeeded_delete",
  ];
  const requiredColumns = new Map([
    ["production_release_attempts", ["version_id", "candidate_commit", "manifest_checksum", "idempotency_key"]],
    ["production_release_targets", [
      "version_id",
      "candidate_commit",
      "manifest_checksum",
      "platform",
      "external_request_id",
      "reconciliation_status",
      "failure_classification",
      "sanitized_error_summary",
      "artifact_identity",
      "production_readback_sha",
      "production_release_id",
      "health_status",
      "readback_status",
      "app_store_app_id",
      "bundle_id",
      "marketing_version",
      "build_number",
      "processing_status",
      "processing_id",
      "review_status",
      "review_submission_id",
      "upload_id",
      "review_id",
      "release_status",
      "release_id",
      "live_status",
      "live_id",
      "live_marketing_version",
      "live_build_number",
      "live_membership_confirmed",
      "sanitized_readback_evidence",
      "sanitized_live_evidence",
    ]],
  ]);
  for (const table of tables) {
    const tableExists = await db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .bind(table)
      .first();
    if (!tableExists) return null;
    const columns = await db.prepare("SELECT name FROM pragma_table_info(?)").bind(table).all();
    const names = new Set(columns.results.map((column) => column.name));
    if (requiredColumns.get(table).some((column) => !names.has(column))) return null;
  }
  for (const name of [...indexes, ...triggers]) {
    const exists = await db
      .prepare("SELECT name FROM sqlite_schema WHERE name = ?")
      .bind(name)
      .first();
    if (!exists) return null;
  }
  return { name: "production_release_attempts" };
}

function productionSchemaDrift() {
  throw new DomainError(
    "PRODUCTION_RELEASE_SCHEMA_DRIFT",
    "production release schema is incomplete or legacy; apply an explicit repair migration before continuing",
  );
}

async function hasProductionReleaseTables(db) {
  const rows = await db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('production_release_attempts', 'production_release_targets')")
    .all();
  return rows.results.length > 0;
}

async function findLegacySentinel(db, sentinel) {
  if (!sentinel) return null;
  if (sentinel.check) return sentinel.check(db);
  if (sentinel.column) {
    return db.prepare(`
      SELECT name
      FROM pragma_table_info(?)
      WHERE name = ?
    `).bind(sentinel.table, sentinel.column).first();
  }
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ?")
    .bind(sentinel.table)
    .first();
}

export async function applyMigrations({ db, migrations, now = new Date().toISOString() }) {
  await db.exec("CREATE TABLE IF NOT EXISTS orchestration_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL, adopted INTEGER NOT NULL CHECK (adopted IN (0, 1)))");
  const applied = [];
  const adopted = [];
  for (const migration of migrations) {
    const recorded = await db
      .prepare("SELECT name FROM orchestration_migrations WHERE name = ?")
      .bind(migration.name)
      .first();
    const sentinel = LEGACY_SENTINELS.get(migration.name);
    const existing = await findLegacySentinel(db, sentinel);
    if (recorded) {
      if (migration.name === "0013_production_release_attempts.sql" && !existing) {
        productionSchemaDrift();
      }
      continue;
    }
    if (!existing) {
      if (migration.name === "0013_production_release_attempts.sql" && await hasProductionReleaseTables(db)) {
        productionSchemaDrift();
      }
      await db.exec(migration.sql);
      applied.push(migration.name);
    } else {
      adopted.push(migration.name);
    }
    await db
      .prepare("INSERT INTO orchestration_migrations (name, applied_at, adopted) VALUES (?, ?, ?)")
      .bind(migration.name, now, existing ? 1 : 0)
      .run();
  }
  return { applied, adopted };
}
import { DomainError } from "../domain/errors.mjs";

import { createHash } from "node:crypto";

import { DomainError } from "../domain/errors.mjs";

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

// Generated from each sqlite_schema.sql definition after applying canonical 0013.
// These are per-object fingerprints, never a hash of the multi-statement migration script.
const PRODUCTION_RELEASE_SCHEMA_FINGERPRINTS = new Map([
  ["production_release_attempts", {
    type: "table",
    tableName: "production_release_attempts",
    sha256: "14e3fc766cbc40fd2650a3e3c1025f5fa2ce4fed4bf1066e94e2c523c7370109",
  }],
  ["production_release_targets", {
    type: "table",
    tableName: "production_release_targets",
    sha256: "fb8591d53f921b870a70aa312d76a58140a2594edd6e47b13c865c7d632b4e01",
  }],
  ["idx_production_release_targets_latest", {
    type: "index",
    tableName: "production_release_targets",
    sha256: "ac593037b6fe55cd0b56624e15e79ce3e1098798ae9b21ba4f64c53e6d3ab863",
  }],
  ["idx_production_release_targets_reusable_success", {
    type: "index",
    tableName: "production_release_targets",
    sha256: "1ce5def10d8a51478415db9f066f22d487390c15869678d2463440ca05cb4774",
  }],
  ["production_release_attempts_immutable_succeeded", {
    type: "trigger",
    tableName: "production_release_attempts",
    sha256: "a8e6265bfd024e8ceedc78fa5045cfa9d890f9d3ccbf59ef3e7f0e3fb7ecf11c",
  }],
  ["production_release_targets_immutable_succeeded", {
    type: "trigger",
    tableName: "production_release_targets",
    sha256: "339b477678dd13cc5184124ff95a54188060a0e5ff4ad0824de1b36268dec54c",
  }],
  ["production_release_attempts_immutable_succeeded_delete", {
    type: "trigger",
    tableName: "production_release_attempts",
    sha256: "17b94f5d5fc20867308f1328567693a87f67802eaaf1c2a7141a9e52f8a1f4be",
  }],
  ["production_release_targets_immutable_succeeded_delete", {
    type: "trigger",
    tableName: "production_release_targets",
    sha256: "7b74e0a1fe20d46623195d9883d2b5a2f3beef6d9b556dab94500eafbae6a19d",
  }],
]);

function normalizeSqliteSchemaDefinition(sql) {
  return String(sql ?? "")
    .split(/('(?:''|[^'])*')/g)
    .map((part, index) => index % 2 === 1
      ? part
      : part
        .replace(/[A-Z]/g, (character) => character.toLowerCase())
        .replace(/[ \t\n\f\r]+/g, " "))
    .join("")
    .trim();
}

function schemaDefinitionFingerprint(sql) {
  return createHash("sha256")
    .update(normalizeSqliteSchemaDefinition(sql))
    .digest("hex");
}

async function hasCompleteProductionReleaseSchema(db) {
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
      "sanitized_observed_evidence",
      "sanitized_readback_evidence",
      "sanitized_live_evidence",
    ]],
  ]);
  for (const [table, required] of requiredColumns) {
    const tableExists = await db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .bind(table)
      .first();
    if (!tableExists) return null;
    const columns = await db.prepare("SELECT name FROM pragma_table_info(?)").bind(table).all();
    const names = new Set(columns.results.map((column) => column.name));
    if (required.some((column) => !names.has(column))) return null;
  }
  for (const [name, expected] of PRODUCTION_RELEASE_SCHEMA_FINGERPRINTS) {
    const actual = await db
      .prepare("SELECT type, tbl_name, sql FROM sqlite_schema WHERE name = ? AND type = ? AND tbl_name = ?")
      .bind(name, expected.type, expected.tableName)
      .first();
    if (
      actual?.type !== expected.type
      || actual?.tbl_name !== expected.tableName
      || schemaDefinitionFingerprint(actual?.sql) !== expected.sha256
    ) return null;
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
      if (migration.name === "0013_production_release_attempts.sql" && !await findLegacySentinel(db, sentinel)) {
        productionSchemaDrift();
      }
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

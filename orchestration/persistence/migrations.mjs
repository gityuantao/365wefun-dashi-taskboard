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
]);

async function findLegacySentinel(db, sentinel) {
  if (!sentinel) return null;
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
    if (recorded) continue;
    const sentinel = LEGACY_SENTINELS.get(migration.name);
    const existing = await findLegacySentinel(db, sentinel);
    if (!existing) {
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

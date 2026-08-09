const LEGACY_SENTINELS = new Map([
  ["0001_initial.sql", "projects"],
  ["0002_orchestration_core.sql", "orchestration_commands"],
  ["0003_clickup_snapshots.sql", "clickup_snapshots"],
  ["0004_outbox_mutations.sql", "outbox_mutations"],
  ["0005_runner_jobs.sql", "runner_jobs"],
  ["0006_failure_tracking.sql", "task_rework"],
  ["0007_release_manifests.sql", "release_manifests"],
  ["0008_release_cleanup_attempts.sql", "release_cleanup_attempts"],
]);

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
    const existing = sentinel
      ? await db
          .prepare("SELECT name FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ?")
          .bind(sentinel)
          .first()
      : null;
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

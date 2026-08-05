const REWORK_LIMIT = 3;

export async function recordFailure({ db, taskId, reason, evidence, now }) {
  const row = await db
    .prepare("SELECT round FROM task_rework WHERE task_id = ?")
    .bind(taskId)
    .first();
  const round = (row?.round ?? 0) + 1;
  await db
    .prepare(
      `INSERT INTO task_rework (task_id, round, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET round = excluded.round, updated_at = excluded.updated_at`,
    )
    .bind(taskId, round, now)
    .run();
  const blocked = round >= REWORK_LIMIT;
  if (blocked) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO blockers (
          id, object_type, object_id, type, reason, status, created_at
        ) VALUES (?, 'task', ?, 'rework_budget', ?, 'open', ?)`,
      )
      .bind(
        `block-${taskId}`,
        taskId,
        `rework budget exhausted after ${round} rounds: ${reason} (${evidence ?? "no evidence"})`,
        now,
      )
      .run();
  }
  return { round, blocked };
}

export async function checkReworkBudget({ db, taskId }) {
  const row = await db
    .prepare("SELECT round FROM task_rework WHERE task_id = ?")
    .bind(taskId)
    .first();
  const round = row?.round ?? 0;
  return { round, exhausted: round >= REWORK_LIMIT };
}

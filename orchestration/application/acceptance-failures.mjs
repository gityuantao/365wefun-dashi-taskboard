export const MAX_ACCEPTANCE_FAILURES = 2;

export function pausedJobId(taskId) {
  return `acceptance-paused-${taskId}`;
}

export async function acceptanceFailureStreak(db, taskId) {
  const rows = await db
    .prepare(`
      SELECT type FROM orchestration_events
      WHERE aggregate_type = 'task' AND aggregate_id = ?
        AND type IN ('task.acceptance_failed', 'task.acceptance_passed')
      ORDER BY sequence DESC LIMIT 100
    `)
    .bind(taskId)
    .all();
  let streak = 0;
  for (const row of rows.results) {
    if (row.type === "task.acceptance_failed") {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

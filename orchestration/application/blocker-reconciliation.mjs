export async function resolveSatisfiedReworkBlockers({ db, taskId, now, dryRun = true }) {
  const [snapshot, aggregate, blockers, events] = await Promise.all([
    db.prepare(`SELECT status FROM clickup_snapshots
      WHERE object_type='task' AND object_id=?`).bind(taskId).first(),
    db.prepare(`SELECT state FROM orchestration_aggregates
      WHERE aggregate_type='task' AND aggregate_id=?`).bind(taskId).first(),
    db.prepare(`SELECT id,created_at FROM blockers
      WHERE object_type='task' AND object_id=? AND type='rework_budget' AND status='open'
      ORDER BY created_at,id`).bind(taskId).all(),
    db.prepare(`SELECT id,occurred_at FROM orchestration_events
      WHERE aggregate_type='task' AND aggregate_id=?
        AND type IN ('task.test_passed','task.release_approved')
      ORDER BY occurred_at DESC,sequence DESC`).bind(taskId).all(),
  ]);
  const eligible = [];
  const skipped = [];
  if (snapshot?.status !== "ready_for_release" || aggregate?.state !== "ready_for_release") {
    for (const blocker of blockers.results) skipped.push({ blockerId: blocker.id, reason: "task_not_ready_for_release" });
    return { eligible, resolved: [], skipped };
  }
  for (const blocker of blockers.results) {
    const evidence = events.results.find((event) => event.occurred_at > blocker.created_at);
    if (evidence) eligible.push({ blockerId: blocker.id, evidenceId: evidence.id });
    else skipped.push({ blockerId: blocker.id, reason: "no_later_test_passed_evidence" });
  }
  if (dryRun || eligible.length === 0) return { eligible, resolved: [], skipped };
  const resolved = [];
  for (const item of eligible) {
    const outcome = await db.prepare(`UPDATE blockers SET status='resolved',resolved_at=?
      WHERE id=? AND object_type='task' AND object_id=? AND type='rework_budget' AND status='open'`)
      .bind(now, item.blockerId, taskId).run();
    if ((outcome.meta?.changes ?? 0) === 1) resolved.push(item);
  }
  return { eligible, resolved, skipped };
}

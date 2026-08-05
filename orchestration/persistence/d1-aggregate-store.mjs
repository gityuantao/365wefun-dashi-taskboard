export async function loadAggregate(db, aggregateType, aggregateId) {
  const row = await db
    .prepare(
      `SELECT aggregate_type, aggregate_id, aggregate_version, state, snapshot
       FROM orchestration_aggregates
       WHERE aggregate_type = ? AND aggregate_id = ?`,
    )
    .bind(aggregateType, aggregateId)
    .first();
  if (!row) {
    return {
      aggregateType,
      aggregateId,
      version: 0,
      state: null,
      snapshot: null,
    };
  }
  return {
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    version: row.aggregate_version,
    state: row.state,
    snapshot: row.snapshot === null ? null : JSON.parse(row.snapshot),
  };
}

export function upsertAggregateStatement(db, { aggregateType, aggregateId, version, state, snapshot, updatedAt }) {
  return db
    .prepare(
      `INSERT INTO orchestration_aggregates (
        aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(aggregate_type, aggregate_id) DO UPDATE SET
        aggregate_version = excluded.aggregate_version,
        state = excluded.state,
        snapshot = excluded.snapshot,
        updated_at = excluded.updated_at`,
    )
    .bind(
      aggregateType,
      aggregateId,
      version,
      state,
      snapshot === null ? null : JSON.stringify(snapshot),
      updatedAt,
    );
}

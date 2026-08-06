export const DASHBOARD_NOW = "2026-08-06T08:00:00.000Z";

export async function seedDashboardFixture(db) {
  const statements = [
    db.prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('task', 'task-1', 'list-task', 'ready_for_release', ?, 'h1', ?)
    `).bind(JSON.stringify({
      id: "task-1",
      listId: "list-task",
      name: "任务一",
      status: "ready_for_release",
      targetVersion: "1.0.1",
      assignee: "狗哥",
      updatedAt: DASHBOARD_NOW,
      fieldsHash: "h1",
    }), DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('task', 'task-2', 'list-task', 'waiting_info', ?, 'h2', ?)
    `).bind(JSON.stringify({
      id: "task-2",
      listId: "list-task",
      name: "任务二",
      status: "waiting_info",
      targetVersion: "1.0.2",
      assignee: null,
      updatedAt: DASHBOARD_NOW,
      fieldsHash: "h2",
    }), DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('task', 'task-3', 'list-task', 'ready_for_release', ?, 'h5', ?)
    `).bind(JSON.stringify({
      id: "task-3",
      listId: "list-task",
      name: "任务三",
      status: "ready_for_release",
      targetVersion: "1.0.3",
      assignee: null,
      updatedAt: DASHBOARD_NOW,
      fieldsHash: "h5",
    }), DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('task', 'task-4', 'list-task', 'ready_for_release', ?, 'h6', ?)
    `).bind(JSON.stringify({
      id: "task-4",
      listId: "list-task",
      name: "任务四",
      status: "ready_for_release",
      targetVersion: "1.0.4",
      assignee: null,
      updatedAt: DASHBOARD_NOW,
      fieldsHash: "h6",
    }), DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('version', 'version-1', 'list-version', 'active', ?, 'h3', ?)
    `).bind(JSON.stringify({
      id: "version-1",
      listId: "list-version",
      name: "1.0.1",
      status: "active",
      blocked: false,
      updatedAt: DASHBOARD_NOW,
      fieldsHash: "h3",
    }), DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('version', 'version-2', 'list-version', 'active', ?, 'h4', ?)
    `).bind(JSON.stringify({
      id: "version-2",
      listId: "list-version",
      name: "1.0.2",
      status: "active",
      blocked: false,
      updatedAt: DASHBOARD_NOW,
      fieldsHash: "h4",
    }), DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('version', 'version-3', 'list-version', 'active', ?, 'h7', ?)
    `).bind(JSON.stringify({
      id: "version-3",
      listId: "list-version",
      name: "1.0.3",
      status: "active",
      blocked: false,
      updatedAt: DASHBOARD_NOW,
      fieldsHash: "h7",
    }), DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO clickup_snapshots (object_type, object_id, list_id, status, snapshot, fields_hash, read_at)
      VALUES ('version', 'version-4', 'list-version', 'release_failed', ?, 'h8', ?)
    `).bind(JSON.stringify({
      id: "version-4",
      listId: "list-version",
      name: "1.0.4",
      status: "release_failed",
      blocked: false,
      updatedAt: DASHBOARD_NOW,
      fieldsHash: "h8",
    }), DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('task', 'task-1', 4, 'ready_for_release', NULL, ?)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('task', 'task-2', 2, 'waiting_info', NULL, ?)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('task', 'task-3', 4, 'ready_for_release', NULL, ?)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('task', 'task-4', 4, 'ready_for_release', NULL, ?)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('version', 'version-1', 1, 'active', NULL, ?)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('version', 'version-2', 1, 'active', NULL, ?)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('version', 'version-3', 1, 'active', NULL, ?)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_aggregates (aggregate_type, aggregate_id, aggregate_version, state, snapshot, updated_at)
      VALUES ('version', 'version-4', 2, 'release_failed', NULL, ?)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO blockers (id, object_type, object_id, type, reason, status, created_at, resolved_at)
      VALUES ('blocker-1', 'task', 'task-3', 'blocked', '等待外部依赖', 'open', ?, NULL)
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_events (id, sequence, aggregate_type, aggregate_id, aggregate_version, type, command_id, actor_id, occurred_at, data, previous_hash, hash)
      VALUES ('evt-1', 1, 'version', 'version-1', 1, 'version.activated', 'cmd-seed-1', 'system', ?, '{}', NULL, 'h-e1')
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_events (id, sequence, aggregate_type, aggregate_id, aggregate_version, type, command_id, actor_id, occurred_at, data, previous_hash, hash)
      VALUES ('evt-2', 2, 'task', 'task-1', 3, 'task.development_completed', 'development-task-1-develop-1', 'runner-developer', ?, '{}', 'h-e1', 'h-e2')
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO orchestration_events (id, sequence, aggregate_type, aggregate_id, aggregate_version, type, command_id, actor_id, occurred_at, data, previous_hash, hash)
      VALUES ('evt-3', 3, 'version', 'version-1', 2, 'version.release_started', 'cmd-seed-3', 'system-aggregator', ?, '{}', 'h-e2', 'h-e3')
    `).bind(DASHBOARD_NOW),
    db.prepare(`
      INSERT INTO runner_jobs (id, command_id, job_type, payload, payload_hash, status, result, created_at, completed_at)
      VALUES ('task-1-analyze-1', 'auto-analyze-task-1', 'analyze', ?, 'p1', 'completed', ?, ?, ?)
    `).bind(
      JSON.stringify({ taskId: "task-1" }),
      JSON.stringify({
        status: "completed",
        summary: {
          scope: "实现登录页",
          acceptance_criteria: [{ criterion: "登录按钮可用" }],
        },
      }),
      DASHBOARD_NOW,
      DASHBOARD_NOW,
    ),
    db.prepare(`
      INSERT INTO runner_jobs (id, command_id, job_type, payload, payload_hash, status, result, created_at, completed_at)
      VALUES ('task-1-develop-1', 'auto-develop-task-1', 'develop', ?, 'p2', 'completed', ?, ?, ?)
    `).bind(
      JSON.stringify({ taskId: "task-1" }),
      JSON.stringify({
        status: "completed",
        pr: { url: "https://github.com/example/pr/1" },
        changeSummary: "完成登录页",
      }),
      DASHBOARD_NOW,
      DASHBOARD_NOW,
    ),
    db.prepare(`
      INSERT INTO runner_jobs (id, command_id, job_type, payload, payload_hash, status, result, created_at, completed_at)
      VALUES ('task-1-accept-1', 'auto-accept-task-1', 'accept', ?, 'p3', 'completed', ?, ?, ?)
    `).bind(
      JSON.stringify({ taskId: "task-1" }),
      JSON.stringify({ status: "completed", result: "accepted" }),
      DASHBOARD_NOW,
      DASHBOARD_NOW,
    ),
    db.prepare(`
      INSERT INTO release_manifests (version_id, manifest, created_at) VALUES ('version-1', ?, ?)
    `).bind(
      JSON.stringify({
        versionId: "version-1",
        taskIds: ["task-1"],
        createdAt: DASHBOARD_NOW,
        checksum: "abc",
      }),
      DASHBOARD_NOW,
    ),
  ];
  await db.batch(statements);
}

import { TASK_STATES } from "../domain/task-state.mjs";
import { compareVersions } from "../release/version-utils.mjs";

const ACTIVITY_LABELS = {
  "task.analysis_started": "开始分析",
  "task.analysis_completed": "分析完成",
  "task.analysis_needs_human": "需要补充信息",
  "task.analysis_restarted": "重新分析",
  "task.development_started": "开始开发",
  "task.development_completed": "开发完成",
  "task.development_failed": "开发失败，退回待开发",
  "task.test_started": "开始测试",
  "task.test_passed": "测试通过",
  "task.test_failed": "测试失败，退回待开发",
  "task.acceptance_started": "开始验收",
  "task.acceptance_passed": "验收通过",
  "task.acceptance_failed": "验收失败，退回待开发",
  "task.published": "已发布",
  "task.canceled": "已取消",
  "version.activated": "进入进行中",
  "version.release_prepared": "待发布",
  "version.release_started": "发布中",
  "version.published": "已发布",
  "version.release_failed": "发布失败",
  "version.release_retried": "重试发布",
  "version.returned_to_active": "退回进行中",
  "version.canceled": "已取消",
};

function parseSnapshot(row) {
  return row.snapshot === null ? null : JSON.parse(row.snapshot);
}

async function loadTasks(db) {
  const rows = (await db.prepare(`
    SELECT s.snapshot, s.status AS snapshot_status, a.state AS aggregate_state
    FROM clickup_snapshots s
    LEFT JOIN orchestration_aggregates a
      ON a.aggregate_type = 'task' AND a.aggregate_id = s.object_id
    WHERE s.object_type = 'task'
  `).all()).results;
  return rows
    .map((row) => ({
      ...parseSnapshot(row),
      status: row.aggregate_state ?? row.snapshot_status,
    }))
    .filter((task) => task?.id);
}

async function loadVersions(db) {
  const rows = (await db.prepare(`
    SELECT s.snapshot, s.status AS snapshot_status, a.state AS aggregate_state
    FROM clickup_snapshots s
    LEFT JOIN orchestration_aggregates a
      ON a.aggregate_type = 'version' AND a.aggregate_id = s.object_id
    WHERE s.object_type = 'version'
  `).all()).results;
  return rows
    .map((row) => ({
      ...parseSnapshot(row),
      status: row.aggregate_state ?? row.snapshot_status,
    }))
    .filter((version) => version?.id);
}

async function loadOpenTaskBlockers(db) {
  const rows = (await db
    .prepare(`
      SELECT object_id FROM blockers
      WHERE status = 'open' AND object_type = 'task'
    `)
    .all()).results;
  return new Set(rows.map((row) => row.object_id));
}

async function latestJob(db, taskId, jobType) {
  return latestJobBefore(db, taskId, jobType, null);
}

async function latestJobBefore(db, taskId, jobType, before) {
  const timeFilter = before === null ? "" : "AND completed_at <= ?";
  const params = before === null
    ? [`${taskId}-${jobType}-%`, jobType]
    : [`${taskId}-${jobType}-%`, jobType, before];
  const row = await db
    .prepare(`
      SELECT result FROM runner_jobs
      WHERE id LIKE ? AND job_type = ? AND status = 'completed' ${timeFilter}
      ORDER BY completed_at DESC, created_at DESC LIMIT 1
    `)
    .bind(...params)
    .first();
  return row ? { result: JSON.parse(row.result) } : null;
}

function prUrlOf(result) {
  if (!result) return null;
  if (typeof result.pr === "string") return result.pr;
  return result.pr?.url ?? null;
}

async function loadActivity(db, limit, tasks, versions) {
  const events = (await db
    .prepare(`
      SELECT aggregate_type, aggregate_id, type, occurred_at, command_id
      FROM orchestration_events
      ORDER BY occurred_at DESC, sequence DESC
      LIMIT ?
    `)
    .bind(limit)
    .all()).results;
  if (events.length === 0) return [];

  const names = new Map([
    ...tasks.map((task) => [`task:${task.id}`, task.name ?? task.id]),
    ...versions.map((version) => [`version:${version.id}`, version.name ?? version.id]),
  ]);

  return Promise.all(events.map(async (event) => {
    const key = `${event.aggregate_type}:${event.aggregate_id}`;
    const name = names.get(key) ?? event.aggregate_id;
    const subject = event.aggregate_type === "version" ? `版本 ${name}` : `任务 ${name}`;
    const label = ACTIVITY_LABELS[event.type] ?? event.type;
    let summary = `${subject} ${label}`;
    if (
      event.type === "task.development_completed"
      && typeof event.command_id === "string"
      && event.command_id.startsWith("development-")
    ) {
      const jobId = event.command_id.slice("development-".length);
      const row = await db
        .prepare("SELECT result FROM runner_jobs WHERE id = ? AND status = 'completed'")
        .bind(jobId)
        .first();
      const result = row ? JSON.parse(row.result) : null;
      if (prUrlOf(result)) {
        summary = `${subject} 开发完成，PR：${prUrlOf(result)}`;
      }
    }
    return {
      time: event.occurred_at,
      objectType: event.aggregate_type,
      objectId: event.aggregate_id,
      eventType: event.type,
      summary,
    };
  }));
}

export async function buildDashboard(db, { versionListUrl } = {}) {
  const [tasks, versions, openTaskBlockers] = await Promise.all([
    loadTasks(db),
    loadVersions(db),
    loadOpenTaskBlockers(db),
  ]);
  const pipeline = Object.fromEntries(TASK_STATES.map((state) => [state, 0]));
  for (const task of tasks) {
    if (pipeline[task.status] !== undefined) pipeline[task.status] += 1;
  }

  const versionProgress = versions
    .map((version) => {
      const tasksInVersion = tasks.filter(
        (task) => task.targetVersion === (version.name ?? version.id),
      );
      const readyCount = tasksInVersion.filter(
        (task) => task.status === "ready_for_release",
      ).length;
      const allReady = tasksInVersion.length > 0
        && tasksInVersion.every((task) => task.status === "ready_for_release");
      const noOpenBlockers = tasksInVersion.every(
        (task) => !openTaskBlockers.has(task.id),
      );
      return {
        id: version.id,
        name: version.name ?? version.id,
        status: version.status ?? null,
        taskCount: tasksInVersion.length,
        readyCount,
        releasable: version.status !== "published"
          && version.status !== "canceled"
          && version.status !== "releasing"
          && version.blocked !== true
          && allReady
          && noOpenBlockers,
        releaseFailed: version.status === "release_failed",
      };
    })
    .sort((left, right) => compareVersions(left.name, right.name) || left.name.localeCompare(right.name));

  const releasableVersions = versionProgress
    .filter((version) => version.releasable)
    .map((version) => ({
      ...version,
      url: versionListUrl ?? `https://app.clickup.com/v/l/${version.id}`,
    }));

  const activity = await loadActivity(db, 20, tasks, versions);
  return { releasableVersions, pipeline, versions: versionProgress, activity };
}

async function loadTimeline(db, taskId) {
  const rows = (await db
    .prepare(`
      SELECT type, occurred_at, data FROM orchestration_events
      WHERE aggregate_type = 'task' AND aggregate_id = ?
      ORDER BY sequence DESC LIMIT 50
    `)
    .bind(taskId)
    .all()).results;
  return rows
    .map((row) => ({
      time: row.occurred_at,
      eventType: row.type,
      summary: ACTIVITY_LABELS[row.type] ?? row.type,
      data: row.data === null ? null : JSON.parse(row.data),
    }))
    .reverse();
}

export async function buildTaskDetail(db, taskId) {
  const [snapshotRow, aggregateRow] = await Promise.all([
    db
      .prepare(`
        SELECT snapshot, status FROM clickup_snapshots
        WHERE object_type = 'task' AND object_id = ?
      `)
      .bind(taskId)
      .first(),
    db
      .prepare(`
        SELECT state FROM orchestration_aggregates
        WHERE aggregate_type = 'task' AND aggregate_id = ?
      `)
      .bind(taskId)
      .first(),
  ]);
  if (!snapshotRow) return null;
  const snapshot = JSON.parse(snapshotRow.snapshot);
  const status = aggregateRow?.state ?? snapshotRow.status;

  const [analyzeJob, developJob, acceptJob, timeline] = await Promise.all([
    latestJob(db, taskId, "analyze"),
    latestJob(db, taskId, "develop"),
    latestJob(db, taskId, "accept"),
    loadTimeline(db, taskId),
  ]);
  const analysisSummary = analyzeJob?.result?.summary ?? null;

  return {
    id: taskId,
    name: snapshot.name ?? taskId,
    targetVersion: snapshot.targetVersion ?? null,
    status,
    assignee: snapshot.assignee ?? null,
    updatedAt: snapshot.updatedAt ?? null,
    summary: analysisSummary?.scope ?? null,
    acceptanceCriteria: (analysisSummary?.acceptance_criteria ?? []).map((criterion) => (
      typeof criterion === "string" ? criterion : criterion.criterion
    )),
    changeSummary: developJob?.result?.changeSummary ?? null,
    prUrl: prUrlOf(developJob?.result),
    acceptanceResult: acceptJob?.result?.result ?? null,
    timeline,
  };
}

export async function buildVersionDetail(db, versionId) {
  const [snapshotRow, aggregateRow, manifestRow, tasks] = await Promise.all([
    db
      .prepare(`
        SELECT snapshot, status FROM clickup_snapshots
        WHERE object_type = 'version' AND object_id = ?
      `)
      .bind(versionId)
      .first(),
    db
      .prepare(`
        SELECT state FROM orchestration_aggregates
        WHERE aggregate_type = 'version' AND aggregate_id = ?
      `)
      .bind(versionId)
      .first(),
    db
      .prepare("SELECT manifest FROM release_manifests WHERE version_id = ?")
      .bind(versionId)
      .first(),
    loadTasks(db),
  ]);
  if (!snapshotRow) return null;
  const snapshot = JSON.parse(snapshotRow.snapshot);
  const status = aggregateRow?.state ?? snapshotRow.status;
  const matchingTasks = tasks.filter(
    (task) => task.targetVersion === (snapshot.name ?? versionId),
  );
  const byTaskId = new Map(matchingTasks.map((task) => [task.id, task]));
  const manifest = manifestRow ? JSON.parse(manifestRow.manifest) : null;
  const orderedTaskIds = manifest
    ? [...new Set([...manifest.taskIds, ...matchingTasks.map((task) => task.id)])]
    : matchingTasks.map((task) => task.id);
  const versionTasks = orderedTaskIds
    .map((taskId) => byTaskId.get(taskId))
    .filter(Boolean)
    .map((task) => ({
      id: task.id,
      name: task.name ?? task.id,
      status: task.status,
      ready: task.status === "ready_for_release",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    id: versionId,
    name: snapshot.name ?? versionId,
    status,
    blocked: snapshot.blocked === true,
    tasks: versionTasks,
    manifest,
  };
}

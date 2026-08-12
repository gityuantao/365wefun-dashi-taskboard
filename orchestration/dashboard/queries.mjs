import { TASK_STATES } from "../domain/task-state.mjs";
import { activeVersionTasks, loadReleasePlatformEvidence } from "../release/release-scope.mjs";
import { compareVersions } from "../release/version-utils.mjs";

const ACTIVITY_LABELS = {
  "task.analysis_started": "开始分析",
  "task.analysis_completed": "分析完成",
  "task.analysis_needs_human": "需要补充信息",
  "task.analysis_restarted": "重新分析",
  "task.development_started": "开始开发",
  "task.development_completed": "开发完成",
  "task.development_failed": "开发失败，退回待开发",
  "task.development_needs_info": "开发需要补充信息",
  "task.development_restarted": "重新开发",
  "task.test_started": "开始测试",
  "task.test_passed": "测试通过",
  "task.test_failed": "测试失败，退回待开发",
  "task.acceptance_started": "开始验收",
  "task.acceptance_passed": "验收通过",
  "task.acceptance_failed": "验收失败，退回待开发",
  "task.acceptance_rejected": "验收不通过，等待确认",
  "task.acceptance_rejected_to_develop": "退回待开发重新开发",
  "task.acceptance_rejected_to_test": "进入待测试",
  "task.published": "已发布",
  "task.canceled": "已取消",
  "version.activated": "进入进行中",
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
    SELECT s.snapshot, s.status AS snapshot_status, a.state AS aggregate_state,
      a.aggregate_version AS aggregate_version
    FROM clickup_snapshots s
    LEFT JOIN orchestration_aggregates a
      ON a.aggregate_type = 'task' AND a.aggregate_id = s.object_id
    WHERE s.object_type = 'task'
  `).all()).results;
  return rows
    .map((row) => {
      // 编排进度与发布门禁以内部状态机为准；ClickUp 快照仍保留用于检测并展示状态分叉。
      const state = row.aggregate_state ?? row.snapshot_status;
      return {
        ...parseSnapshot(row),
        status: state === "accepting" ? "developing" : state,
        snapshotStatus: row.snapshot_status ?? null,
        canceled: row.snapshot_status === "canceled",
        aggregateState: row.aggregate_state ?? null,
        aggregateVersion: row.aggregate_version ?? null,
      };
    })
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
  const row = await db
    .prepare(`
      SELECT result FROM runner_jobs
      WHERE id LIKE ? AND job_type = ? AND status = 'completed'
      ORDER BY completed_at DESC, created_at DESC LIMIT 1
    `)
    .bind(`${taskId}-${jobType}-%`, jobType)
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
    if (
      event.type === "task.acceptance_failed"
      && typeof event.command_id === "string"
      && event.command_id.startsWith("acceptance-")
    ) {
      const row = await db
        .prepare("SELECT result FROM runner_jobs WHERE command_id = ? AND status = 'completed'")
        .bind(event.command_id)
        .first();
      const result = row ? JSON.parse(row.result) : null;
      const findings = result?.findings ?? [];
      if (findings.length > 0) {
        const reasons = findings
          .slice(0, 2)
          .map((finding) => String(finding?.description ?? "").replace(/\s+/g, " ").trim().slice(0, 80))
          .filter(Boolean)
          .join("；");
        if (reasons) {
          summary = `${subject} 验收失败：${reasons}`;
        }
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
  const [tasks, versions, openTaskBlockers, manifestRows] = await Promise.all([
    loadTasks(db),
    loadVersions(db),
    loadOpenTaskBlockers(db),
    db.prepare("SELECT version_id, manifest FROM release_manifests").all(),
  ]);
  const manifests = new Map(manifestRows.results.map((row) => [row.version_id, JSON.parse(row.manifest)]));
  const pipeline = Object.fromEntries(
    TASK_STATES.filter((state) => state !== "accepting").map((state) => [state, 0]),
  );
  for (const task of tasks) {
    const displayStatus = task.canceled ? "canceled" : task.status;
    if (pipeline[displayStatus] !== undefined) pipeline[displayStatus] += 1;
  }

  const versionProgress = versions
    .filter((version) => version.status !== "published" && version.status !== "canceled")
    .map((version) => {
      const tasksInVersion = activeVersionTasks({
        tasks, versionName: version.name ?? version.id, manifest: manifests.get(version.id) ?? null,
      });
      const readyCount = tasksInVersion.filter(
        (task) => task.status === "ready_for_release",
      ).length;
      const notReadyCount = tasksInVersion.filter(
        (task) => task.status !== "ready_for_release",
      ).length;
      const hasOpenBlockers = tasksInVersion.some(
        (task) => openTaskBlockers.has(task.id),
      );
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
        notReadyCount,
        hasOpenBlockers,
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
      id: version.id,
      name: version.name,
      taskCount: version.taskCount,
      readyCount: version.readyCount,
      releaseFailed: version.releaseFailed,
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
  const rawStatus = aggregateRow?.state ?? snapshotRow.status;
  const status = rawStatus === "accepting" ? "developing" : rawStatus;

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

export async function buildVersionDetail(db, versionId, { iosApps = [] } = {}) {
  const [snapshotRow, aggregateRow, manifestRow, tasks, targetRowsResult, openTaskBlockers] = await Promise.all([
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
    db.prepare(`SELECT platform, app_id, attempt, stage, status, sanitized_error_summary,
      review_status, live_status, build_number, reconciliation_status, readback_status, updated_at
      FROM production_release_targets WHERE version_id = ?
      ORDER BY platform, app_id, attempt DESC`).bind(versionId).all(),
    loadOpenTaskBlockers(db),
  ]);
  if (!snapshotRow) return null;
  const snapshot = JSON.parse(snapshotRow.snapshot);
  const status = aggregateRow?.state ?? snapshotRow.status;
  const storedManifest = manifestRow ? JSON.parse(manifestRow.manifest) : null;
  const matchingTasks = activeVersionTasks({
    tasks, versionName: snapshot.name ?? versionId, manifest: storedManifest,
  });
  const byTaskId = new Map(tasks.map((task) => [task.id, task]));
  const safePlan = storedManifest?.productionTargetPlan ? {
    schemaVersion: storedManifest.productionTargetPlan.schemaVersion,
    taskPlatforms: storedManifest.productionTargetPlan.taskPlatforms,
    platforms: storedManifest.productionTargetPlan.platforms,
    iosApps: storedManifest.productionTargetPlan.iosApps.map((app) => ({
      id: app.id, name: app.name, appStoreAppId: app.appStoreAppId,
      scheme: app.scheme, bundleId: app.bundleId, marketingVersion: app.marketingVersion,
    })),
  } : null;
  const manifest = storedManifest ? {
    versionId: storedManifest.versionId,
    taskIds: storedManifest.taskIds,
    createdAt: storedManifest.createdAt,
    checksum: storedManifest.checksum,
    candidateCommit: storedManifest.candidateCommit ?? null,
    productionTargetPlan: safePlan,
  } : null;
  const orderedTaskIds = storedManifest
    ? [...new Set(storedManifest.taskIds)]
    : matchingTasks.map((task) => task.id);
  const missingManifestTaskIds = storedManifest
    ? orderedTaskIds.filter((taskId) => !byTaskId.has(taskId))
    : [];
  const versionTasks = orderedTaskIds
    .map((taskId) => byTaskId.get(taskId))
    .filter(Boolean)
    .map((task) => ({
      id: task.id,
      name: task.name ?? task.id,
      status: task.status,
      ready: (task.aggregateState ?? task.snapshotStatus) === "ready_for_release",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const releasable = versionTasks.length > 0
    && versionTasks.every((task) => task.ready)
    && snapshot.blocked !== true
    && status !== "published"
    && status !== "canceled"
    && status !== "releasing";

  const gaps = [];
  if (versionTasks.length === 0) gaps.push("版本内至少需要一个任务");
  if (missingManifestTaskIds.length > 0) gaps.push(`Manifest 任务快照缺失：${missingManifestTaskIds.join("、")}`);
  if (versionTasks.some((task) => !task.ready)) gaps.push("版本任务必须全部处于待发布");
  const workflowDrift = matchingTasks.filter((task) => (
    task.snapshotStatus === "ready_for_release"
    && task.aggregateState !== null
    && task.aggregateState !== "ready_for_release"
  ));
  if (workflowDrift.length > 0) {
    gaps.push(`任务内部流程尚未就绪：${workflowDrift.map((task) => `${task.id}(${task.aggregateState})`).join("、")}`);
  }
  if (snapshot.blocked === true) gaps.push("版本存在开放阻塞项");
  const blockedTasks = versionTasks.filter((task) => openTaskBlockers.has(task.id));
  if (blockedTasks.length > 0) gaps.push(`任务存在开放阻塞项：${blockedTasks.map((task) => task.id).join("、")}`);
  if (["published", "canceled", "releasing"].includes(status)) gaps.push("当前版本状态不可发起发布");
  const resolvedTaskPlatforms = storedManifest?.productionTargetPlan?.taskPlatforms
    ? storedManifest.productionTargetPlan.taskPlatforms.map((item) => ({ ...item, source: "frozen_manifest" }))
    : await loadReleasePlatformEvidence(db, matchingTasks);
  const platformScope = resolvedTaskPlatforms;
  const taskPlatforms = platformScope.flatMap((task) => Array.isArray(task.platforms) ? task.platforms : []);
  const missingPlatformTasks = platformScope.filter((task) => !Array.isArray(task.platforms) || task.platforms.length === 0);
  if (missingPlatformTasks.length > 0) gaps.push(`任务缺少影响平台：${missingPlatformTasks.map((task) => task.taskId).join("、")}`);
  const invalidPlatformTasks = platformScope.filter((task) => Array.isArray(task.platforms)
    && task.platforms.some((value) => typeof value !== "string" || value.trim() === ""));
  if (invalidPlatformTasks.length > 0) gaps.push(`任务影响平台格式无效：${invalidPlatformTasks.map((task) => task.taskId).join("、")}`);
  const supported = new Set(["web", "api", "ios"]);
  const unsupported = [...new Set(taskPlatforms.filter((value) => typeof value === "string").map((value) => value.trim().toLowerCase()).filter((value) => value && !supported.has(value)))];
  if (unsupported.length > 0) gaps.push(`尚未配置的生产平台：${unsupported.join("、")}`);
  const latestTargets = new Map();
  for (const row of targetRowsResult.results) {
    const key = `${row.platform}:${row.app_id}`;
    if (!latestTargets.has(key)) latestTargets.set(key, row);
  }
  const planned = storedManifest?.productionTargetPlan;
  const normalizedPlatforms = taskPlatforms.filter((value) => typeof value === "string").map((value) => value.trim().toLowerCase());
  const platformFlags = planned?.platforms ?? {
    web: normalizedPlatforms.includes("web"), api: normalizedPlatforms.includes("api"), ios: normalizedPlatforms.includes("ios"),
  };
  const plannedTargets = [];
  for (const platform of ["web", "api"]) if (platformFlags[platform]) plannedTargets.push({ platform, appId: null, label: platform.toUpperCase() });
  const plannedApps = platformFlags.ios ? (planned?.iosApps ?? iosApps.filter((app) => app.enabled !== false)) : [];
  const previewMarketingVersion = String(snapshot.name ?? versionId).replace(/^v(?=\d)/i, "");
  for (const app of plannedApps) plannedTargets.push({
    platform: "ios", appId: app.id, label: app.name,
    appStoreAppId: app.appStoreAppId, scheme: app.scheme, bundleId: app.bundleId,
    marketingVersion: app.marketingVersion ?? previewMarketingVersion,
  });
  if (platformFlags.ios && plannedApps.length === 0) gaps.push("iOS 生产目标注册表为空");
  const actualTargets = new Map([...latestTargets.values()].map((row) => {
    const plannedTarget = plannedTargets.find((target) => `${target.platform}:${target.appId ?? ""}` === `${row.platform}:${row.app_id}`);
    return [`${row.platform}:${row.app_id}`, {
    ...plannedTarget,
    platform: row.platform,
    appId: row.app_id || null,
    label: plannedTarget?.label ?? row.platform.toUpperCase(),
    stage: row.stage,
    status: row.status,
    attempt: row.attempt,
    updatedAt: row.updated_at,
    error: row.sanitized_error_summary ?? null,
    reviewStatus: row.review_status ?? null,
    liveStatus: row.live_status ?? null,
    buildNumber: row.build_number ?? null,
    reconciliationStatus: row.reconciliation_status ?? null,
    readbackStatus: row.readback_status ?? null,
  }];
  }));
  const releaseTargets = plannedTargets.map((target) => actualTargets.get(`${target.platform}:${target.appId ?? ""}`) ?? {
    ...target, stage: "pending", status: "pending", attempt: 0, updatedAt: snapshot.updatedAt ?? null,
    error: null, reviewStatus: null, liveStatus: null, buildNumber: null, reconciliationStatus: null, readbackStatus: null,
  });
  for (const [key, target] of actualTargets) {
    if (!plannedTargets.some((plannedTarget) => `${plannedTarget.platform}:${plannedTarget.appId ?? ""}` === key)) releaseTargets.push(target);
  }

  return {
    id: versionId,
    name: snapshot.name ?? versionId,
    status,
    releasable,
    blocked: snapshot.blocked === true || blockedTasks.length > 0,
    tasks: versionTasks,
    manifest,
    releaseReadiness: { ready: releasable && gaps.length === 0, gaps },
    taskPlatforms: resolvedTaskPlatforms.map(({ taskId, platforms, source }) => ({ taskId, platforms, source })),
    releaseTargets,
  };
}

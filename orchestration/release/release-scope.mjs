import { normalizePlatforms } from "../domain/platforms.mjs";

function nonEmpty(value) {
  return Array.isArray(value) && normalizePlatforms(value).length > 0;
}

function currentJob(job, { taskId, aggregateVersion, acceptedCommitSha, requireCommit = false }) {
  if (!job || job.status !== "completed") return false;
  if (job.payload?.taskId && job.payload.taskId !== taskId) return false;
  const commitSha = job.result?.commitSha ?? job.payload?.commitSha ?? job.payload?.acceptedCommitSha ?? null;
  if (acceptedCommitSha && requireCommit) return commitSha === acceptedCommitSha;
  const version = job.result?.aggregateVersion ?? job.payload?.aggregateVersion;
  return version === undefined || version === null || Number(version) === Number(aggregateVersion);
}

function newestCurrent(jobs, context, platformsOf) {
  for (const job of jobs ?? []) {
    if (!currentJob(job, context)) continue;
    const platforms = platformsOf(job);
    if (nonEmpty(platforms)) return { job, platforms };
  }
  return null;
}

export function activeVersionTasks({ tasks, versionName, manifest }) {
  const byId = new Map((tasks ?? []).map((task) => [task.id, task]));
  if (Array.isArray(manifest?.taskIds)) {
    return manifest.taskIds.map((taskId) => byId.get(taskId)).filter(Boolean);
  }
  return (tasks ?? []).filter((task) => (
    task.targetVersion === versionName && task.status !== "canceled" && task.canceled !== true
  ));
}

export function canonicalizeReleasePlatforms(values, {
  androidDelivery = null,
  nativeAndroidChanged = null,
} = {}) {
  const normalized = normalizePlatforms(values);
  const projected = [];
  for (const platform of normalized) {
    if (platform === "android" && androidDelivery === "web_twa" && nativeAndroidChanged === false) {
      projected.push("web");
    } else {
      projected.push(platform);
    }
  }
  return [...new Set(projected)];
}

function result({ taskId, platforms, source, evidenceId = null, commitSha = null, aggregateVersion, androidDelivery = null }) {
  return {
    taskId,
    platforms: canonicalizeReleasePlatforms(platforms, {
      androidDelivery,
      nativeAndroidChanged: androidDelivery === "web_twa" ? false : null,
    }),
    source,
    evidenceId,
    commitSha,
    aggregateVersion,
    androidDelivery,
  };
}

export function resolveReleasePlatformEvidence({
  task,
  developJobs = [],
  analyzeJobs = [],
  stageJobs = [],
  aggregate = {},
  acceptedCommitSha = null,
}) {
  const context = { taskId: task.id, aggregateVersion: aggregate.version, acceptedCommitSha };
  if (nonEmpty(task.platforms)) {
    return result({
      taskId: task.id, platforms: task.platforms, source: "clickup_snapshot",
      aggregateVersion: aggregate.version,
    });
  }

  const staged = newestCurrent(stageJobs, { ...context, requireCommit: true }, (job) => {
    const commitSha = job.payload?.commitSha ?? job.payload?.acceptedCommitSha;
    if (!acceptedCommitSha || commitSha !== acceptedCommitSha) return [];
    return job.payload?.platforms;
  });
  if (staged) {
    return result({
      taskId: task.id,
      platforms: staged.platforms,
      source: "staging_job",
      evidenceId: staged.job.id,
      commitSha: staged.job.payload?.commitSha ?? staged.job.payload?.acceptedCommitSha ?? null,
      aggregateVersion: aggregate.version,
      androidDelivery: staged.job.payload?.androidDelivery ?? null,
    });
  }

  const developed = newestCurrent(developJobs, { ...context, requireCommit: Boolean(acceptedCommitSha) }, (job) => job.result?.platforms);
  if (developed) {
    return result({
      taskId: task.id,
      platforms: developed.platforms,
      source: "develop_job",
      evidenceId: developed.job.id,
      commitSha: developed.job.result?.commitSha ?? null,
      aggregateVersion: aggregate.version,
      androidDelivery: developed.job.result?.androidDelivery ?? null,
    });
  }

  const analyzed = newestCurrent(analyzeJobs, context, (job) => job.result?.summary?.platforms);
  if (analyzed) {
    return result({
      taskId: task.id,
      platforms: analyzed.platforms,
      source: "analyze_job",
      evidenceId: analyzed.job.id,
      aggregateVersion: aggregate.version,
      androidDelivery: analyzed.job.result?.summary?.androidDelivery ?? null,
    });
  }

  return result({
    taskId: task.id, platforms: [], source: "missing", aggregateVersion: aggregate.version,
  });
}

function parsed(value) {
  if (value === null || value === undefined) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export async function loadReleasePlatformEvidence(db, tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const ids = new Set(tasks.map((task) => task.id));
  const rows = (await db.prepare(`
    SELECT id, job_type, payload, status, result, created_at, completed_at
    FROM runner_jobs
    WHERE job_type IN ('develop', 'analyze', 'stage_task', 'accept')
      AND status = 'completed'
    ORDER BY COALESCE(completed_at, created_at) DESC, created_at DESC
  `).all()).results;
  const byTask = new Map(tasks.map((task) => [task.id, {
    developJobs: [], analyzeJobs: [], stageJobs: [], acceptJobs: [],
  }]));
  for (const row of rows) {
    const payload = parsed(row.payload) ?? {};
    const resultValue = parsed(row.result) ?? {};
    const taskId = payload.taskId ?? resultValue.taskId ?? row.id.split("-")[0];
    if (!ids.has(taskId)) continue;
    const job = { ...row, payload, result: resultValue };
    const bucket = byTask.get(taskId);
    if (row.job_type === "develop") bucket.developJobs.push(job);
    else if (row.job_type === "analyze") bucket.analyzeJobs.push(job);
    else if (row.job_type === "stage_task") bucket.stageJobs.push(job);
    else if (row.job_type === "accept") bucket.acceptJobs.push(job);
  }
  return tasks.map((task) => {
    const jobs = byTask.get(task.id);
    const acceptedCommitSha = jobs.acceptJobs.find((job) => (
      job.result?.result === "accepted" && typeof job.result?.commitSha === "string"
    ))?.result.commitSha ?? null;
    return resolveReleasePlatformEvidence({
      task,
      aggregate: { version: task.aggregateVersion ?? null },
      acceptedCommitSha,
      ...jobs,
    });
  });
}

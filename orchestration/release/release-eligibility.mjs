const DELIVERY_TARGET = Object.freeze({ android_twa: "web" });

function platforms(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .map((value) => value.trim().toLowerCase())
    .map((value) => DELIVERY_TARGET[value] ?? value))].sort();
}

function configured(values) {
  return new Set(platforms(values));
}

function candidatePlatforms(candidateScope) {
  return platforms(candidateScope?.platforms);
}

function evidenceFor(taskId, platformEvidence) {
  return platformEvidence.find((item) => item?.taskId === taskId) ?? null;
}

export function buildReleaseEligibility({
  version = {},
  tasks = [],
  blockers = [],
  platformEvidence = [],
  candidateScope = null,
  configuredTargets = [],
  runtimeReadiness = { ready: true },
}) {
  const gaps = [];
  const taskIds = tasks.map((task) => task.id).filter(Boolean).sort();
  const targets = configured(configuredTargets);
  const candidateTargets = candidatePlatforms(candidateScope);
  const unsupported = [...new Set(candidateScope?.unsupported ?? [])].sort();
  if (taskIds.length === 0) gaps.push("version has no tasks");
  const blockedIds = new Set((blockers ?? []).map((blocker) => (
    typeof blocker === "string" ? blocker : blocker?.taskId ?? blocker?.object_id
  )).filter(Boolean));
  const taskPlatforms = [];
  for (const task of tasks) {
    if (task.status !== "ready_for_release") gaps.push(`task is not ready for release: ${task.id}`);
    if (blockedIds.has(task.id)) gaps.push(`blocked task: ${task.id}`);
    const evidence = evidenceFor(task.id, platformEvidence);
    let taskScope = platforms(evidence?.platforms);
    let source = evidence?.source ?? "missing";
    if (taskScope.length === 0 && evidence && candidateTargets.length > 0) {
      taskScope = candidateTargets;
      source = "candidate_scope";
    }
    if (taskScope.length === 0) gaps.push(`task missing release platform evidence: ${task.id}`);
    if (candidateScope && taskScope.some((platform) => !candidateTargets.includes(platform))) {
      gaps.push(`task platform drift from Candidate evidence: ${task.id} (${taskScope.filter((platform) => !candidateTargets.includes(platform)).join(", ")})`);
    }
    for (const platform of taskScope) {
      if (!targets.has(platform)) gaps.push(`production target is not configured: ${platform}`);
    }
    taskPlatforms.push({
      taskId: task.id,
      platforms: taskScope,
      source,
      evidenceId: evidence?.evidenceId ?? null,
      commitSha: evidence?.commitSha ?? null,
      acceptedCommitSha: evidence?.acceptedCommitSha ?? null,
    });
  }
  if (version.blocked === true) gaps.push("version has open blockers");
  if (["published", "canceled", "releasing"].includes(version.status)) gaps.push("version status is not releasable");
  for (const platform of unsupported) gaps.push(`unsupported Candidate platform: ${platform}`);
  if (runtimeReadiness?.ready !== true) gaps.push(runtimeReadiness?.error ?? "production runtime is not ready");
  const plannedTargets = [...new Set([
    ...candidateTargets,
    ...taskPlatforms.flatMap((item) => item.platforms),
  ])].sort();
  return {
    ready: gaps.length === 0,
    gaps,
    taskIds,
    taskPlatforms,
    candidateScope,
    plannedTargets,
  };
}

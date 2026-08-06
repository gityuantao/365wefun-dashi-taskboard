import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import { loadLastConfirmed } from "../clickup/snapshot.mjs";

export async function loadAllTaskSnapshots(db) {
  const rows = await db
    .prepare("SELECT snapshot FROM clickup_snapshots WHERE object_type = 'task'")
    .all();
  return rows.results.map((row) => JSON.parse(row.snapshot));
}

export async function checkVersionGate({ db, versionId }) {
  const versionSnapshot = await loadLastConfirmed(db, "version", versionId);
  const matchKey = versionSnapshot?.name ?? versionId;
  const tasks = (await loadAllTaskSnapshots(db)).filter(
    (task) => task.targetVersion === matchKey,
  );
  const reasons = [];
  if (tasks.length === 0) {
    reasons.push("version has no tasks");
  }
  const notReady = [];
  for (const task of tasks) {
    const aggregate = await loadAggregate(db, "task", task.id);
    const state = aggregate.state ?? task.status;
    if (state !== "ready_for_release") {
      notReady.push(task);
    }
  }
  if (notReady.length > 0) {
    reasons.push(`tasks not ready for release: ${[...new Set(notReady.map((task) => task.id))].join(", ")}`);
  }
  const blockers = await db
    .prepare("SELECT object_id FROM blockers WHERE status = 'open' AND object_type = 'task'")
    .all();
  const blockedIds = new Set(blockers.results.map((row) => row.object_id));
  const blockedTasks = tasks.filter((task) => blockedIds.has(task.id));
  if (blockedTasks.length > 0) {
    reasons.push(`blocked tasks: ${blockedTasks.map((task) => task.id).join(", ")}`);
  }
  return { pass: reasons.length === 0, reasons };
}

function checksum(value) {
  const json = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export async function freezeManifest({ db, versionId, now }) {
  const gate = await checkVersionGate({ db, versionId });
  if (!gate.pass) {
    return { status: "rejected", reasons: gate.reasons };
  }
  const versionSnapshot = await loadLastConfirmed(db, "version", versionId);
  const matchKey = versionSnapshot?.name ?? versionId;
  const tasks = (await loadAllTaskSnapshots(db)).filter(
    (task) => task.targetVersion === matchKey,
  );
  const taskIds = tasks.map((task) => task.id).sort();
  const manifest = {
    versionId,
    taskIds,
    createdAt: now,
    checksum: checksum({ versionId, taskIds, createdAt: now }),
  };
  await db
    .prepare(
      `INSERT INTO release_manifests (version_id, manifest, created_at) VALUES (?, ?, ?)
       ON CONFLICT(version_id) DO UPDATE SET manifest = excluded.manifest, created_at = excluded.created_at`,
    )
    .bind(versionId, JSON.stringify(manifest), now)
    .run();

  return { status: "frozen", manifest };
}

export async function loadManifest({ db, versionId }) {
  const row = await db
    .prepare("SELECT manifest FROM release_manifests WHERE version_id = ?")
    .bind(versionId)
    .first();
  return row ? JSON.parse(row.manifest) : null;
}

// 打印本地编排库当前状态：聚合、作业、快照、Manifest。
// 用法：node scripts/orchestration-status.mjs
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";

const persistRoot = ".data/orchestration-d1";
const mf = new Miniflare({
  modules: true,
  scriptPath: "cloud/src/index.mjs",
  modulesRoot: process.cwd(),
  compatibilityDate: "2026-07-24",
  bindings: {},
  d1Databases: { DB: "orchestration-db" },
  defaultPersistRoot: persistRoot,
  d1Persist: true,
});
await mf.ready;
const db = await mf.getD1Database("DB");

const aggregates = await db
  .prepare("SELECT aggregate_type, aggregate_id, aggregate_version, state FROM orchestration_aggregates ORDER BY aggregate_type, aggregate_id")
  .all();
console.log("== aggregates ==");
for (const row of aggregates.results) {
  console.log(`${row.aggregate_type} ${row.aggregate_id} v${row.aggregate_version} ${row.state}`);
}

const jobs = await db
  .prepare("SELECT id, job_type, status, completed_at FROM runner_jobs ORDER BY created_at DESC LIMIT 8")
  .all();
console.log("== jobs (recent) ==");
for (const row of jobs.results) {
  console.log(`${row.id} ${row.job_type} ${row.status}${row.completed_at ? ` @ ${row.completed_at}` : ""}`);
}

const snapshots = await db
  .prepare("SELECT object_type, object_id, status FROM clickup_snapshots ORDER BY object_type, object_id")
  .all();
console.log("== snapshots ==");
for (const row of snapshots.results) {
  console.log(`${row.object_type} ${row.object_id} ${row.status}`);
}

const manifests = await db
  .prepare("SELECT version_id FROM release_manifests")
  .all();
console.log("== manifests ==");
for (const row of manifests.results) {
  console.log(row.version_id);
}

await mf.dispose();

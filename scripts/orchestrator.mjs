// ClickUp 编排 MVP 本地运行时：轮询调度 + Outbox + Companion 执行器，一体常驻进程。
// 用法：node scripts/orchestrator.mjs（配置见 .data/orchestration.json 或 ORCHESTRATION_CONFIG）
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { pollClickUpOnce } from "../cloud/src/clickup-poller.mjs";
import { createClickUpClient } from "../orchestration/clickup/client.mjs";
import {
  fieldId,
  loadClickUpConfig,
} from "../orchestration/clickup/config-registry.mjs";
import { flushOutbox } from "../orchestration/clickup/outbox.mjs";
import { executeAcceptance } from "../orchestration/ai/acceptance.mjs";
import { executeAnalysis } from "../orchestration/ai/analyzer.mjs";
import { executeDevelopment } from "../orchestration/ai/developer.mjs";
import {
  loadLastConfirmed,
  normalizeVersion,
  saveSnapshot,
} from "../orchestration/clickup/snapshot.mjs";
import { enqueueMutation } from "../orchestration/clickup/outbox.mjs";
import { createDomainEvent } from "../orchestration/domain/events.mjs";
import { parseCommandEnvelope } from "../orchestration/domain/commands.mjs";
import { appendCommandResult } from "../orchestration/persistence/d1-event-store.mjs";
import {
  checkVersionGate,
  freezeManifest,
  loadManifest,
} from "../orchestration/release/version-aggregator.mjs";
import { handleConfirmRelease } from "../orchestration/application/release-commands.mjs";
import { correctionText } from "../orchestration/clickup/state-comments.mjs";
import { createWebAdapter } from "../orchestration/release/adapters/web.mjs";
import { checkDevelopmentOrder } from "../orchestration/application/development-order.mjs";
import { assignTaskVersion } from "../orchestration/application/version-assignment.mjs";
import {
  checkTaskVersionGate,
  resolveCurrentDevVersionName,
  targetVersionOfTask,
} from "../orchestration/application/version-gate.mjs";
import { runCodex } from "../orchestration/runner/codex-runner.mjs";
import {
  createTaskWorktree,
  removeTaskWorktree,
  runInWorktree,
} from "../orchestration/runner/worktree.mjs";
import { claimJob, completeJob } from "../orchestration/persistence/d1-runner-jobs.mjs";
import { loadAggregate } from "../orchestration/persistence/d1-aggregate-store.mjs";
import { startDashboardServer } from "../orchestration/dashboard/http-server.mjs";
import { createPullRequest } from "../orchestration/git/pr.mjs";
import { readControl, shouldProcess } from "../orchestration/control.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = process.env.ORCHESTRATION_CONFIG
  ?? path.join(PROJECT_ROOT, ".data", "orchestration.json");
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, "cloud", "migrations");
const CONTROL_PATH = process.env.ORCHESTRATION_CONTROL_PATH
  ?? path.join(PROJECT_ROOT, ".data", "orchestration-control.json");

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

const runtime = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const token = process.env.CLICKUP_API_TOKEN
  ?? readFileSync(runtime.tokenPath, "utf8").trim();
const config = loadClickUpConfig(
  JSON.parse(readFileSync(path.join(PROJECT_ROOT, runtime.clickupConfigPath), "utf8")),
);

const persistRoot = path.join(PROJECT_ROOT, ".data", "orchestration-d1");
mkdirSync(persistRoot, { recursive: true });
const miniflare = new Miniflare({
  modules: true,
  scriptPath: path.join(PROJECT_ROOT, "cloud", "src", "index.mjs"),
  modulesRoot: PROJECT_ROOT,
  compatibilityDate: "2026-07-24",
  bindings: {
    TASKBOARD_ENVIRONMENT: "production",
    TASKBOARD_SHARED_SECRET: "orchestration-local",
  },
  d1Databases: { DB: "orchestration-db" },
  r2Buckets: { ATTACHMENTS: "orchestration-attachments" },
  defaultPersistRoot: persistRoot,
  d1Persist: true,
  r2Persist: true,
});
await miniflare.ready;
const db = await miniflare.getD1Database("DB");
const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort();
const existingTable = await db
  .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'projects'")
  .first();
if (!existingTable) {
  for (const name of migrations) {
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
  }
}

const clientFactory = async ({ token: clientToken }) => createClickUpClient({
  token: clientToken,
});

function pollEnv() {
  return {
    DB: db,
    CLICKUP_API_TOKEN: token,
    CLICKUP_CONFIG: JSON.stringify(config),
    CLICKUP_LIST_SET: runtime.listSet ?? "sandbox",
    CLICKUP_REPO_PATH: runtime.repoPath,
    CLICKUP_WORKTREES_ROOT: runtime.worktreesRoot,
    CLICKUP_BASE_REF: runtime.baseRef ?? "main",
  };
}

const gitOps = {
  createWorktree: ({ repoPath, taskId, baseRef, worktreesRoot }) => createTaskWorktree({
    repoPath,
    taskId,
    baseRef,
    worktreesRoot,
  }),
  commitAll: (worktreePath, message) => {
    runInWorktree(worktreePath, ["add", "-A"]);
    const commit = runInWorktree(worktreePath, ["commit", "-m", message]);
    const output = `${commit.stdout}\n${commit.stderr}`;
    if (commit.status !== 0 && !/nothing to commit/.test(output)) {
      throw new Error(`git commit failed: ${output.trim()}`);
    }
  },
  createPullRequest: ({ repoPath, branch, base, baseRef, title, body }) => {
    if (base && base !== "main") {
      const remote = execFileSync(
        "git",
        ["-C", repoPath, "ls-remote", "--heads", "origin", `refs/heads/${base}`],
        { encoding: "utf8" },
      ).trim();
      if (!remote) {
        execFileSync("git", ["-C", repoPath, "branch", base, baseRef ?? "main"], {
          stdio: "ignore",
        });
        execFileSync("git", ["-C", repoPath, "push", "-u", "origin", base], {
          stdio: "ignore",
        });
      }
    }
    execFileSync("git", ["-C", repoPath, "push", "-u", "origin", branch], {
      stdio: "ignore",
    });
    return createPullRequest({ branch, base, title, body });
  },
};

const codex = {
  run: async ({ prompt, workdir, taskId }) => runCodex({
    workdir: workdir ?? runtime.repoPath,
    prompt,
    timeoutMinutes: runtime.codexTimeoutMinutes ?? 20,
    codexBin: runtime.codexBin ?? "codex",
  }),
};

const taskListKey = (runtime.listSet ?? "sandbox") === "production" ? "task" : "taskSandbox";
const versionListKey = (runtime.listSet ?? "sandbox") === "production" ? "version" : "versionSandbox";

const dashboardServer = await startDashboardServer({
  db,
  port: Number(runtime.dashboardPort ?? process.env.ORCHESTRATION_DASHBOARD_PORT ?? 47824),
  versionListUrl: `https://app.clickup.com/${encodeURIComponent(config.spaceId)}/v/l/${encodeURIComponent(config.lists[versionListKey].id)}`,
  controlPath: CONTROL_PATH,
});
log(`dashboard listening on http://127.0.0.1:${dashboardServer.port}`);

const handlers = {
  analyze: async (job) => {
    const client = await clientFactory({ token });
    const assignment = await assignTaskVersion({
      taskId: job.payload.taskId,
      client,
      config,
      taskListKey,
      versionListKey,
      codex,
      now: new Date().toISOString(),
      log,
    });
    if (assignment.error) {
      return { status: "failed", error: `version assignment failed: ${assignment.error}` };
    }
    const versions = await client.getVersionsByList(config.lists[versionListKey].id);
    const currentDevVersion = resolveCurrentDevVersionName(versions);
    const gate = checkTaskVersionGate({
      targetVersion: assignment.versionName,
      currentDevVersion,
    });
    if (gate.blocked) {
      return { status: "failed", error: `waiting_version: ${gate.reason}` };
    }
    return executeAnalysis({
      job,
      db,
      client,
      codex,
      now: new Date().toISOString(),
      fieldIds: {
        summary: fieldId(config, taskListKey, "执行摘要"),
        acceptance: fieldId(config, taskListKey, "验收标准"),
      },
    });
  },
  develop: async (job) => {
    const client = await clientFactory({ token });
    const gate = await checkDevelopmentOrder({
      db,
      taskId: job.payload.taskId,
      client,
      listId: config.lists[taskListKey].id,
      now: new Date().toISOString(),
    });
    if (gate.blocked) {
      return { status: "failed", error: `waiting: ${gate.reason}` };
    }
    const task = await client.getTask(job.payload.taskId);
    const targetVersion = targetVersionOfTask(task, config, taskListKey);
    const versions = await client.getVersionsByList(config.lists[versionListKey].id);
    const currentDevVersion = resolveCurrentDevVersionName(versions);
    const versionGate = checkTaskVersionGate({ targetVersion, currentDevVersion });
    if (versionGate.blocked) {
      return { status: "failed", error: `waiting_version: ${versionGate.reason}` };
    }
    return executeDevelopment({
      job,
      db,
      client,
      codex,
      gitOps,
      now: new Date().toISOString(),
      fieldIds: {
        evidence: fieldId(config, taskListKey, "证据链接"),
      },
    });
  },
  accept: async (job) => {
    const client = await clientFactory({ token });
    const task = await client.getTask(job.payload.taskId);
    const targetVersion = targetVersionOfTask(task, config, taskListKey);
    const versions = await client.getVersionsByList(config.lists[versionListKey].id);
    const currentDevVersion = resolveCurrentDevVersionName(versions);
    const gate = checkTaskVersionGate({ targetVersion, currentDevVersion });
    if (gate.blocked) {
      return { status: "failed", error: `waiting_version: ${gate.reason}` };
    }
    let acceptanceFeedbackField = null;
    try {
      acceptanceFeedbackField = fieldId(config, taskListKey, "验收反馈");
    } catch {
      // 未配置「验收反馈」字段时只发完整评论
    }
    return executeAcceptance({
      job,
      db,
      client,
      codex,
      now: new Date().toISOString(),
      fieldIds: { feedback: acceptanceFeedbackField },
    });
  },
};

async function recoverOrphanedLeases() {
  // 单进程运行时：启动时把所有 claimed 作业重置为 queued，回收中断进程的租约。
  await db
    .prepare(
      "UPDATE runner_jobs SET status = 'queued', device_id = NULL WHERE status = 'claimed'",
    )
    .run();
}

async function ensureVersionActive(versionId, now) {
  const aggregate = await loadAggregate(db, "version", versionId);
  if (aggregate.version > 0) return;
  const event = await createDomainEvent({
    id: `seed-${versionId}`,
    sequence: 1,
    aggregateType: "version",
    aggregateId: versionId,
    aggregateVersion: 1,
    type: "version.activated",
    commandId: `seed-cmd-${versionId}`,
    actorId: "system",
    occurredAt: now,
    data: { from: "planning", to: "active" },
    previousHash: null,
  });
  await appendCommandResult(db, {
    command: parseCommandEnvelope({
      id: `seed-cmd-${versionId}`,
      type: "activate_version",
      aggregateType: "version",
      aggregateId: versionId,
      expectedVersion: 1,
      actorId: "system",
      issuedAt: now,
      reason: "version activated",
      parameters: {},
    }),
    events: [event],
    projection: { state: "active", snapshot: { kind: "version" } },
  });
}

async function releaseCoordinator(now) {
  const client = await clientFactory({ token });
  const versions = await client.getVersionsByList(config.lists[versionListKey].id);
  for (const payload of versions) {
    const snapshot = normalizeVersion(payload, config, versionListKey);
    await saveSnapshot(db, { type: "version", snapshot, readAt: now });
    // 始终激活版本聚合，确保 syncStatuses 能同步/纠正版本状态
    await ensureVersionActive(snapshot.id, now);
    // 状态驱动：用户把版本状态改为「发布中」即触发发布
    if (snapshot.status !== "releasing") continue;
    const versionId = snapshot.id;
    const existingManifest = await loadManifest({ db, versionId });
    if (!existingManifest) {
      const gate = await checkVersionGate({ db, versionId });
      if (!gate.pass) {
        log(`version ${versionId} gate: ${gate.reasons.join("; ")}`);
        continue;
      }
      const frozen = await freezeManifest({ db, versionId, now });
      log(`version ${versionId} manifest ${frozen.status}`);
    }
    const versionAggregate = await loadAggregate(db, "version", versionId);
    if (versionAggregate.state === "published") continue;
    const adapter = createWebAdapter({
      deployer: {
        preflight: async () => ({ ok: true }),
        upload: async ({ versionId: vid }) => ({
          object: `releases/${vid}/index.html`,
        }),
        switchEntry: async () => ({ url: "https://e365.example.com" }),
        healthCheck: async () => ({ ok: true, status: 200 }),
      },
    });
    const result = await handleConfirmRelease({
      db,
      versionId,
      actorId: "system-poller",
      actorRoles: ["release_manager"],
      now,
      adapter,
      client,
    });
    log(`version ${versionId} release -> ${result.status}${result.error ? `: ${result.error}` : ""}`);
    if (result.status === "succeeded") {
      const manifest = await loadManifest({ db, versionId });
      for (const taskId of (manifest?.taskIds ?? [])) {
        try {
          removeTaskWorktree({
            repoPath: runtime.repoPath,
            taskId,
            worktreesRoot: runtime.worktreesRoot,
          });
          log(`cleaned worktree for task ${taskId}`);
        } catch (error) {
          log(`worktree cleanup failed for ${taskId}: ${error.message}`);
        }
      }
    }
  }
}

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

async function syncStatuses(now) {
  const aggregates = await db
    .prepare(
      "SELECT aggregate_type, aggregate_id, aggregate_version, state FROM orchestration_aggregates",
    )
    .all();
  for (const row of aggregates.results) {
    const map = row.aggregate_type === "version" ? config.versionStatusMap : config.taskStatusMap;
    const clickupStatus = Object.entries(map).find(([, value]) => value === row.state)?.[0];
    if (!clickupStatus) continue;
    // 读取 ClickUp 最新快照：只有实际状态与聚合状态不一致时才写回，
    // 避免幂等跳过导致用户手动改的状态（如版本提前拖到发布中）不被纠正。
    const snapshot = await loadLastConfirmed(db, row.aggregate_type, row.aggregate_id);
    if (snapshot && snapshot.status === row.state) continue;
    // 系统纠正手动漂移的状态时，评论区说明原因
    const correction = correctionText(row.aggregate_type, row.state, snapshot?.status ?? null);
    const pending = await db
      .prepare(`
        SELECT id FROM outbox_mutations
        WHERE object_type = ? AND object_id = ? AND field = 'status' AND status = 'pending'
        LIMIT 1
      `)
      .bind(row.aggregate_type, row.aggregate_id)
      .first();
    const latest = await db
      .prepare(`
        SELECT occurred_at, data FROM orchestration_events
        WHERE aggregate_type = ? AND aggregate_id = ?
        ORDER BY sequence DESC LIMIT 1
      `)
      .bind(row.aggregate_type, row.aggregate_id)
      .first();
    let movedBySystem = false;
    if (latest?.data) {
      try {
        movedBySystem = JSON.parse(latest.data)?.to === row.state
          && Date.parse(latest.occurred_at) > Date.parse(now) - 120_000;
      } catch {
        // 事件数据解析失败时按人工漂移处理
      }
    }
    if (correction && !pending && !movedBySystem) {
      try {
        const client = await clientFactory({ token });
        await client.postComment(row.aggregate_id, correction);
      } catch {
        // 评论失败不影响状态纠正
      }
    }
    const mutationId = `sync-${row.aggregate_type}-${row.aggregate_id}-${row.aggregate_version}-${now}`;
    const existing = await db
      .prepare("SELECT status FROM outbox_mutations WHERE id = ?")
      .bind(mutationId)
      .first();
    if (existing) continue;
    await enqueueMutation(db, {
      mutationId,
      objectType: row.aggregate_type,
      objectId: row.aggregate_id,
      field: "status",
      expectedBefore: null,
      target: clickupStatus,
      actor: "system-sync",
      expiresAt: addMinutes(now, 10),
      createdAt: now,
    });
    log(`sync ${row.aggregate_type} ${row.aggregate_id} -> ${clickupStatus}`);
  }
}

async function tick() {
  const now = new Date().toISOString();
  const control = await readControl(CONTROL_PATH);
  if (!shouldProcess(control)) {
    log("orchestration paused");
    return;
  }
  try {
    try {
      const poll = await pollClickUpOnce(pollEnv(), { now, clientFactory });
      if (poll.processed > 0) {
        log(`poller: ${poll.processed} changed, ${poll.commands.length} commands`);
        for (const command of poll.commands) {
          log(`  command ${command.type} -> ${command.status}${command.error ? `: ${command.error}` : ""}`);
        }
      }
    } catch (error) {
      log(`poller error: ${error.message}`);
    }
    try {
      await releaseCoordinator(now);
    } catch (error) {
      log(`release coordinator error: ${error.message}`);
    }
    try {
      await syncStatuses(now);
    } catch (error) {
      log(`status sync error: ${error.message}`);
    }
    try {
      await flushOutbox(db, await clientFactory({ token }), { now, config });
    } catch (error) {
      log(`outbox error: ${error.message}`);
    }
    for (const jobType of ["analyze", "develop", "accept"]) {
      let job;
      try {
        job = await claimJob(db, { deviceId: runtime.deviceId, jobType, now });
      } catch (error) {
        log(`claim ${jobType} error: ${error.message}`);
        continue;
      }
      if (!job) continue;
      log(`claimed ${jobType} job ${job.id}`);
      void runJob(job, now);
    }
  } catch (error) {
    log(`tick error: ${error.message}`);
  }
}

async function runJob(job, now) {
  const handler = handlers[job.jobType];
  let result;
  try {
    result = await handler(job);
  } catch (error) {
    result = { status: "failed", error: error.message };
  }
  const finalStatus = result.status === "completed" ? "completed" : "failed";
  try {
    await completeJob(db, {
      jobId: job.id,
      deviceId: runtime.deviceId,
      fencingToken: job.fencingToken,
      status: finalStatus,
      result,
      now,
    });
  } catch (error) {
    log(`complete ${job.jobType} job ${job.id} error: ${error.message}`);
  }
  log(`${job.jobType} job ${job.id} -> ${finalStatus}`);
  if (finalStatus === "failed") {
    log(`  error: ${JSON.stringify(result.error ?? result)}`);
  }
  try {
    const syncNow = new Date().toISOString();
    await syncStatuses(syncNow);
    await flushOutbox(db, await clientFactory({ token }), { now: syncNow, config });
  } catch (error) {
    log(`post-job sync error: ${error.message}`);
  }
}

await recoverOrphanedLeases();
log(`orchestrator started: device=${runtime.deviceId} repo=${runtime.repoPath} list=${runtime.listSet ?? "sandbox"}`);
await tick();
setInterval(tick, runtime.pollIntervalMs ?? 30_000);

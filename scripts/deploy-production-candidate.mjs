#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MODES = new Set(["regression", "artifact", "preflight", "upload", "switch", "health", "readback"]);
const COMMANDS = new Set(["pnpm", "npm", "node", "pm2"]);

function required(value, label) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function command(value, label) {
  if (!Array.isArray(value) || value.length === 0 || !COMMANDS.has(value[0])) {
    throw new Error(`${label} is outside the production command allowlist`);
  }
  const parts = value.map((part) => required(part, label));
  if (parts.some((part) => /[\n\r\0;&|`$<>]/.test(part)) || parts.some((part) => ["-e", "--eval", "exec", "dlx"].includes(part))) {
    throw new Error(`${label} arguments are outside the production command allowlist`);
  }
  if (parts[0] === "node" && (!parts[1]?.startsWith("scripts/") || parts[1].includes(".."))) {
    throw new Error(`${label} script is outside the production command allowlist`);
  }
  return parts;
}

function productionValue(value, label) {
  const result = required(value, label);
  if (/staging|test-api|test-admin|test-au/i.test(result)) throw new Error(`${label} must not use staging defaults`);
  return result;
}

export function loadProductionDeploymentConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("production config must be an object");
  const remoteNodePath = productionValue(input.remoteNodePath, "remoteNodePath");
  if (!path.posix.isAbsolute(remoteNodePath)) throw new Error("remoteNodePath must be an absolute path");
  const remoteBinPath = productionValue(input.remoteBinPath, "remoteBinPath");
  if (!path.posix.isAbsolute(remoteBinPath)) throw new Error("remoteBinPath must be an absolute path");
  const currentLinkMode = input.currentLinkMode === "shared" ? "shared" : "per-platform";
  return {
    sshHost: productionValue(input.sshHost, "sshHost"),
    remoteNodePath,
    remoteBinPath,
    currentLinkMode,
    releaseRoot: productionValue(input.releaseRoot, "releaseRoot"),
    repoPath: productionValue(input.repoPath, "repoPath"),
    sharedEnvPath: productionValue(input.sharedEnvPath, "sharedEnvPath"),
    publicUrl: productionValue(input.publicUrl, "publicUrl"),
    adminUrl: productionValue(input.adminUrl, "adminUrl"),
    apiReadyUrl: productionValue(input.apiReadyUrl, "apiReadyUrl"),
    databaseReadyCommand: input.databaseReadyCommand == null ? null : command(input.databaseReadyCommand, "databaseReadyCommand"),
    redisReadyCommand: input.redisReadyCommand == null ? null : command(input.redisReadyCommand, "redisReadyCommand"),
    installCommand: command(input.installCommand, "installCommand"),
    buildCommand: command(input.buildCommand, "buildCommand"),
    restartCommand: command(input.restartCommand, "restartCommand"),
  };
}

function environmentIdentity(environment) {
  const mode = required(environment.PRODUCTION_RELEASE_MODE, "PRODUCTION_RELEASE_MODE");
  if (!MODES.has(mode)) throw new Error(`unsupported production release mode: ${mode}`);
  const candidateCommit = required(environment.PRODUCTION_CANDIDATE_COMMIT, "PRODUCTION_CANDIDATE_COMMIT");
  if (!/^[0-9a-f]{40}$/i.test(candidateCommit)) throw new Error("PRODUCTION_CANDIDATE_COMMIT must be a full SHA");
  const platform = required(environment.PRODUCTION_PLATFORM || "web", "PRODUCTION_PLATFORM");
  if (!["web", "api"].includes(platform)) throw new Error("PRODUCTION_PLATFORM must be web or api");
  let artifactIdentity;
  try { artifactIdentity = JSON.parse(required(environment.PRODUCTION_ARTIFACT_IDENTITY, "PRODUCTION_ARTIFACT_IDENTITY")); } catch { throw new Error("PRODUCTION_ARTIFACT_IDENTITY must be JSON"); }
  const candidateEvidenceMode = mode === "regression" || mode === "artifact";
  return {
    mode,
    versionId: required(environment.PRODUCTION_VERSION_ID, "PRODUCTION_VERSION_ID"),
    candidateCommit,
    manifestChecksum: candidateEvidenceMode
      ? String(environment.PRODUCTION_MANIFEST_CHECKSUM ?? "")
      : required(environment.PRODUCTION_MANIFEST_CHECKSUM, "PRODUCTION_MANIFEST_CHECKSUM"),
    platform,
    artifactIdentity,
    idempotencyKey: String(environment.PRODUCTION_IDEMPOTENCY_KEY ?? ""),
    externalRequestId: String(environment.PRODUCTION_EXTERNAL_REQUEST_ID ?? ""),
    productionReleaseId: String(environment.PRODUCTION_RELEASE_ID ?? ""),
  };
}

export const PRODUCTION_REMOTE_SOURCE = String.raw`
const fs=require('node:fs');const cp=require('node:child_process');const p=require('node:path');
const [operation,encoded]=process.argv.slice(1);const x=JSON.parse(Buffer.from(encoded,'base64url').toString());
const out=v=>process.stdout.write(typeof v==='string'?v:JSON.stringify(v));
const atomicLink=(target,link)=>{fs.mkdirSync(p.dirname(link),{recursive:true});const t=link+'.tmp-'+process.pid;try{fs.unlinkSync(t)}catch{}fs.symlinkSync(target,t);fs.renameSync(t,link)};
const run=cmd=>{const r=cp.spawnSync(cmd[0],cmd.slice(1),{stdio:['ignore','ignore','pipe'],cwd:x.cwd,env:{PATH:(x.remoteBinPath?x.remoteBinPath+':':'')+(process.env.PATH||''),RELEASE_ID:x.releaseId||'',GIT_SHA:x.candidateCommit||''},encoding:'utf8'});if(r.status!==0)throw new Error('remote command failed: '+String(r.stderr||'').slice(0,1000))};
if(operation==='preflight'){fs.mkdirSync(p.join(x.releaseRoot,'releases'),{recursive:true,mode:0o755});fs.mkdirSync(p.join(x.releaseRoot,'state'),{recursive:true,mode:0o700});out({ok:true})}
else if(operation==='read-current'){try{out(fs.realpathSync(p.join(x.releaseRoot,x.platform?'current-'+x.platform:'current')))}catch{out('')}}
else if(operation==='prepare-immutable-release'){const marker=p.join(x.releasePath,'.release-identity.json');if(!fs.existsSync(x.releasePath)){const temp=x.releasePath+'.prepare-'+process.pid;fs.mkdirSync(temp,{recursive:false,mode:0o755});fs.writeFileSync(p.join(temp,'.release-identity.json'),JSON.stringify(x.identity)+'\n',{mode:0o600,flag:'wx'});try{fs.renameSync(temp,x.releasePath)}catch(e){fs.rmSync(temp,{recursive:true,force:true});if(!fs.existsSync(x.releasePath))throw e}}const actual=JSON.parse(fs.readFileSync(marker,'utf8'));if(JSON.stringify(actual)!==JSON.stringify(x.identity))throw new Error('immutable release identity mismatch');out({ok:true})}
else if(operation==='inspect-immutable-release'){const f=p.join(x.releasePath,'release-metadata.json');if(!fs.existsSync(f))out({complete:false});else{const actual=JSON.parse(fs.readFileSync(f,'utf8'));if(JSON.stringify(actual)!==JSON.stringify(x.identity))throw new Error('completed release identity mismatch');out({complete:true})}}
else if(operation==='link-shared-env'){const f=p.join(x.releasePath,'.env');if(fs.existsSync(f)){if(fs.realpathSync(f)!==fs.realpathSync(x.envPath))throw new Error('shared env link mismatch')}else fs.symlinkSync(x.envPath,f);out({ok:true})}
else if(operation==='write-release-metadata'){const f=p.join(x.releasePath,'release-metadata.json');if(fs.existsSync(f)){const actual=JSON.parse(fs.readFileSync(f,'utf8'));if(JSON.stringify(actual)!==JSON.stringify(x.metadata))throw new Error('release metadata mismatch')}else{fs.writeFileSync(f+'.tmp',JSON.stringify(x.metadata)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(f+'.tmp',f)}out({ok:true})}
else if(operation==='read-release-metadata'){out(JSON.parse(fs.readFileSync(p.join(x.releasePath,'release-metadata.json'),'utf8')))}
else if(operation==='switch-current-atomic'||operation==='restore-current-atomic'){atomicLink(x.releasePath,p.join(x.releaseRoot,x.platform?'current-'+x.platform:'current'));out({ok:true})}
else if(operation==='restart'||operation==='ready-command'){run(x.command);out({ok:true})}
else if(operation==='read-state'){try{out(JSON.parse(fs.readFileSync(x.path,'utf8')))}catch(e){if(e.code==='ENOENT')out(null);else throw e}}
else if(operation==='write-state-atomic'){fs.mkdirSync(p.dirname(x.path),{recursive:true,mode:0o700});const f=x.path+'.tmp-'+process.pid;fs.writeFileSync(f,JSON.stringify(x.value)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(f,x.path);out({ok:true})}
else throw new Error('unsupported remote operation');`;

function defaultOperations() {
  return {
    runLocal: (file, args, options) => execFileAsync(file, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, ...options }),
    runRemote: async (host, operation, payload, remoteNodePath) => {
      const { stdout } = await execFileAsync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, remoteNodePath, "-e", PRODUCTION_REMOTE_SOURCE, operation, Buffer.from(JSON.stringify(payload)).toString("base64url")], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
      const value = stdout.trim();
      if (!value) return null;
      try { return JSON.parse(value); } catch { return value; }
    },
    probe: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      let body = null;
      if (url.includes("/health/ready")) {
        try { body = await response.json(); } catch {}
      }
      return { ok: response.ok, status: response.status, body };
    },
    now: () => new Date().toISOString(),
  };
}

export function createProductionDeployment({ environment, config, operations = defaultOperations() }) {
  const identity = environmentIdentity(environment);
  const target = loadProductionDeploymentConfig(config);
  const suffix = identity.candidateCommit.slice(0, 8);
  const releaseId = `${identity.versionId}-${identity.manifestChecksum}-${identity.platform}-${suffix}`.replace(/[^A-Za-z0-9._-]/g, "-");
  const releasePath = path.posix.join(target.releaseRoot, "releases", releaseId);
  const statePath = path.posix.join(target.releaseRoot, "state", `${identity.platform}.json`);
  const currentPlatform = target.currentLinkMode === "shared" ? null : identity.platform;
  let previousReleasePath = null;
  const runRemote = (operation, payload) => operations.runRemote(
    target.sshHost, operation, payload, target.remoteNodePath,
  );

  const readRemoteState = operations.readRemoteState
    ?? ((_host, file) => runRemote("read-state", { path: file }));
  const writeRemoteStateAtomic = operations.writeRemoteStateAtomic
    ?? ((_host, file, value) => runRemote("write-state-atomic", { path: file, value }));

  async function writeState(values) {
    const state = {
      versionId: identity.versionId,
      candidateCommit: identity.candidateCommit,
      manifestChecksum: identity.manifestChecksum,
      artifactIdentity: identity.artifactIdentity,
      platform: identity.platform,
      releaseId,
      externalRequestId: identity.idempotencyKey || `release:${releaseId}`,
      updatedAt: operations.now(),
      ...values,
    };
    await writeRemoteStateAtomic(target.sshHost, statePath, state);
    return state;
  }

  return {
    async execute(mode = identity.mode) {
      if (!MODES.has(mode)) throw new Error(`unsupported production release mode: ${mode}`);
      if (mode === "regression") {
        const worktree = await mkdtemp(path.join(tmpdir(), "e365-production-regression-"));
        try {
          await operations.runLocal("git", ["-C", target.repoPath, "worktree", "add", "--detach", worktree, identity.candidateCommit]);
          const verified = await operations.runLocal("git", ["-C", worktree, "rev-parse", "HEAD"]);
          if (verified?.stdout && verified.stdout.trim() !== identity.candidateCommit) throw new Error("detached worktree Candidate mismatch");
          await operations.runLocal("pnpm", ["test"], { cwd: worktree });
          return { passed: true, command: "pnpm test", candidateCommit: identity.candidateCommit };
        } finally {
          try { await operations.runLocal("git", ["-C", target.repoPath, "worktree", "remove", "--force", worktree]); } catch {}
          await rm(worktree, { recursive: true, force: true });
        }
      }
      if (mode === "artifact") {
        return identity.artifactIdentity ?? {
          digest: `git:${identity.candidateCommit}`,
          candidateCommit: identity.candidateCommit,
        };
      }
      if (mode === "preflight") {
        await runRemote("preflight", { releaseRoot: target.releaseRoot, platform: identity.platform });
        return { ok: true };
      }
      if (mode === "upload") {
        const releaseIdentity = { versionId: identity.versionId, candidateCommit: identity.candidateCommit, manifestChecksum: identity.manifestChecksum, artifactIdentity: identity.artifactIdentity, platform: identity.platform, releaseId };
        await runRemote("prepare-immutable-release", { releasePath, identity: releaseIdentity });
        const inspection = await runRemote("inspect-immutable-release", { releasePath, identity: releaseIdentity });
        if (inspection?.complete === true) {
          const existingState = await readRemoteState(target.sshHost, statePath);
          return {
            object: releasePath,
            etag: identity.artifactIdentity?.digest ?? identity.manifestChecksum,
            externalRequestId: existingState?.externalRequestId ?? (identity.idempotencyKey || `release:${releaseId}`),
          };
        }
        const worktree = await mkdtemp(path.join(tmpdir(), "e365-production-candidate-"));
        try {
          await operations.runLocal("git", ["-C", target.repoPath, "worktree", "add", "--detach", worktree, identity.candidateCommit]);
          const verified = await operations.runLocal("git", ["-C", worktree, "rev-parse", "HEAD"]);
          if (verified?.stdout && verified.stdout.trim() !== identity.candidateCommit) throw new Error("detached worktree Candidate mismatch");
          await operations.runLocal(target.installCommand[0], target.installCommand.slice(1), { cwd: worktree });
          await operations.runLocal(target.buildCommand[0], target.buildCommand.slice(1), { cwd: worktree });
          previousReleasePath = await runRemote("read-current", { releaseRoot: target.releaseRoot, platform: currentPlatform });
          await operations.runLocal("rsync", ["-az", "--delete", "--exclude", ".git", "--exclude", ".env*", "--exclude", ".release-identity.json", "--exclude", "release-metadata.json", `${worktree}/`, `${target.sshHost}:${releasePath}/`]);
          await runRemote("link-shared-env", { releasePath, envPath: target.sharedEnvPath });
          const metadata = releaseIdentity;
          await runRemote("write-release-metadata", { releasePath, metadata });
          await writeState({ status: "uploaded", previousReleasePath, currentReleasePath: releasePath });
          return { object: releasePath, etag: identity.artifactIdentity?.digest ?? identity.manifestChecksum, externalRequestId: identity.idempotencyKey || `release:${releaseId}` };
        } finally {
          try { await operations.runLocal("git", ["-C", target.repoPath, "worktree", "remove", "--force", worktree]); } catch {}
          await rm(worktree, { recursive: true, force: true });
        }
      }
      if (mode === "switch") {
        const existing = await readRemoteState(target.sshHost, statePath);
        previousReleasePath = existing?.previousReleasePath ?? await runRemote("read-current", { releaseRoot: target.releaseRoot, platform: currentPlatform });
        await runRemote("switch-current-atomic", { releaseRoot: target.releaseRoot, releasePath, previousReleasePath, platform: currentPlatform });
        try {
          await runRemote("restart", { command: target.restartCommand, releaseId, candidateCommit: identity.candidateCommit, cwd: releasePath, remoteBinPath: target.remoteBinPath });
        } catch (error) {
          let rollbackObservation = { currentReleasePath: previousReleasePath, restored: false, observedAt: operations.now() };
          if (previousReleasePath) {
            try {
              await runRemote("restore-current-atomic", { releaseRoot: target.releaseRoot, releasePath: previousReleasePath, platform: currentPlatform });
              await runRemote("restart", { command: target.restartCommand, releaseId: "rollback", candidateCommit: null, cwd: previousReleasePath, remoteBinPath: target.remoteBinPath });
              rollbackObservation = { ...rollbackObservation, restored: true };
            } catch {
              rollbackObservation = { ...rollbackObservation, error: "rollback restart failed" };
            }
          }
          await writeState({ status: "rolled_back", previousReleasePath, currentReleasePath: previousReleasePath, failedObservation: { stage: "restart", observedAt: operations.now() }, rollbackObservation });
          throw error;
        }
        await writeState({ status: "switched", previousReleasePath, currentReleasePath: releasePath });
        return { url: identity.platform === "api" ? target.apiReadyUrl : target.publicUrl, productionReleaseId: releaseId };
      }
      if (mode === "health") {
        const existing = await readRemoteState(target.sshHost, statePath);
        previousReleasePath = existing?.previousReleasePath ?? null;
        const probes = await Promise.all([target.publicUrl, target.adminUrl, target.apiReadyUrl].map((url) => operations.probe(url)));
        const apiProbe = probes[2];
        const endpointChecks = apiProbe?.body?.checks;
        const database = target.databaseReadyCommand
          ? await runRemote("ready-command", { kind: "database", command: target.databaseReadyCommand, cwd: releasePath, remoteBinPath: target.remoteBinPath })
          : { ok: endpointChecks?.db === "ok" };
        const redis = target.redisReadyCommand
          ? await runRemote("ready-command", { kind: "redis", command: target.redisReadyCommand, cwd: releasePath, remoteBinPath: target.remoteBinPath })
          : { ok: endpointChecks?.redis === "ok" };
        const healthy = probes.every((probe) => probe?.ok === true) && database?.ok === true && redis?.ok === true;
        if (!healthy) {
          const failedObservation = { healthStatus: "unhealthy", probes, database, redis, observedAt: operations.now() };
          let rollbackObservation = { currentReleasePath: previousReleasePath, restored: false, observedAt: operations.now() };
          if (previousReleasePath) {
            try {
              await runRemote("restore-current-atomic", { releaseRoot: target.releaseRoot, releasePath: previousReleasePath, platform: currentPlatform });
              await runRemote("restart", { command: target.restartCommand, releaseId: "rollback", candidateCommit: null, cwd: previousReleasePath, remoteBinPath: target.remoteBinPath });
              rollbackObservation = { ...rollbackObservation, restored: true };
            } catch (rollbackError) {
              rollbackObservation = { ...rollbackObservation, restored: false, error: "rollback restart failed" };
            }
          }
          await writeState({ status: "rolled_back", previousReleasePath, currentReleasePath: previousReleasePath, failedObservation, rollbackObservation });
          throw new Error(rollbackObservation.restored
            ? "production health check failed; previous release restored"
            : "production health check failed; previous release was not restored");
        }
        await writeState({ status: "published", previousReleasePath, currentReleasePath: releasePath, healthStatus: "healthy", healthEvidence: { probes, database, redis } });
        return { ok: true, status: 200 };
      }
      const state = await readRemoteState(target.sshHost, statePath);
      if (!state || state.status !== "published") throw new Error("authoritative production state is not published");
      const currentReleasePath = await runRemote("read-current", { releaseRoot: target.releaseRoot, platform: currentPlatform });
      const metadata = await runRemote("read-release-metadata", { releasePath: currentReleasePath });
      if (
        currentReleasePath !== releasePath
        || metadata?.candidateCommit !== identity.candidateCommit
        || metadata?.manifestChecksum !== identity.manifestChecksum
        || metadata?.releaseId !== releaseId
        || JSON.stringify(metadata?.artifactIdentity) !== JSON.stringify(identity.artifactIdentity)
      ) throw new Error("authoritative production readback mismatch");
      return {
        confirmed: true, published: true, status: "published", authoritative: true,
        candidateCommit: state.candidateCommit, artifactIdentity: state.artifactIdentity,
        externalRequestId: state.externalRequestId, productionReleaseId: state.releaseId,
        healthStatus: state.healthStatus, url: identity.platform === "api" ? target.apiReadyUrl : target.publicUrl,
        evidence: { statePath, observedAt: operations.now(), healthEvidence: state.healthEvidence },
      };
    },
  };
}

async function main() {
  const configPath = required(process.env.PRODUCTION_CONFIG_PATH, "PRODUCTION_CONFIG_PATH");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const deployment = createProductionDeployment({ environment: process.env, config });
  console.log(JSON.stringify(await deployment.execute()));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

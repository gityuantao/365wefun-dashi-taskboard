import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import provider from "../../orchestration/mini-program/sandbox-providers/darwin-sandbox-exec.mjs";
import stageRunner from "../../orchestration/mini-program/stage-runners/wechat-command.mjs";
import { createTrustedMiniProgramRuntimeLoader } from "../../orchestration/mini-program/trusted-runtime-loader.mjs";

test("Darwin provider readiness reflects sandbox-exec availability instead of configuration", async () => {
  const ready = await provider.readiness();
  assert.equal(ready.platform, "darwin");
  assert.equal(typeof ready.available, "boolean");
  assert.equal(ready.available, process.platform === "darwin");
});

test("production fixed-root loader imports the reviewed provider and stage runner", async () => {
  if (!(await provider.readiness()).available) {
    await assert.rejects(createTrustedMiniProgramRuntimeLoader({
      sandboxProviderModule: "darwin-sandbox-exec.mjs",
      stageRunnerModule: "wechat-command.mjs",
    }), /unavailable/i);
    return;
  }
  const runtime = await createTrustedMiniProgramRuntimeLoader({
    sandboxProviderModule: "darwin-sandbox-exec.mjs",
    stageRunnerModule: "wechat-command.mjs",
  });
  assert.equal(runtime.provider, provider);
  assert.equal(runtime.stageRunner, stageRunner);
});

test("Darwin provider runs a detached process group with network denied and only its output root writable", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wechat-darwin-provider-")));
  t.after(async () => { await chmod(source, 0o700); await rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  const denied = path.join(root, "denied");
  const privateFile = path.join(root, "private.txt");
  await Promise.all([mkdir(source), mkdir(output, { mode: 0o700 }), mkdir(denied, { mode: 0o700 })]);
  await writeFile(privateFile, "must-not-be-readable", { mode: 0o600 });
  const script = path.join(source, "probe.sh");
  await writeFile(script, [
    "#!/bin/sh",
    "printf ok > \"$OUTPUT/result.txt\"",
    "printf blocked > \"$SOURCE/mutated.txt\" 2>/dev/null || true",
    "printf blocked > \"$DENIED/secret.txt\" 2>/dev/null || true",
    "/bin/cat \"$PRIVATE\" > \"$OUTPUT/private-read.txt\" 2>/dev/null || true",
    "/usr/bin/curl -I --max-time 1 https://example.com > \"$OUTPUT/curl.txt\" 2>&1",
    "printf '%s' \"$?\" > \"$OUTPUT/curl-exit.txt\"",
    "exit 0",
  ].join("\n"), { mode: 0o500 });
  const session = provider.createSession({
    file: "/bin/sh", args: [script], cwd: source,
    env: { PATH: "/usr/bin:/bin", LANG: "C", OUTPUT: output, SOURCE: source, DENIED: denied, PRIVATE: privateFile },
    network: { mode: "deny-all", profileId: provider.profileId },
    filesystem: { readOnlyRoots: [source], writableRoots: [output], deniedRoots: [denied], mounts: [] },
    processGroup: { detached: true, terminateOnFailure: true, awaitExit: true },
    implementationId: provider.implementationId,
  });
  const completion = await session.start();
  await session.wait();
  assert.deepEqual(completion, { exitCode: 0 });
  assert.equal(await readFile(path.join(output, "result.txt"), "utf8"), "ok");
  assert.notEqual(await readFile(path.join(output, "curl-exit.txt"), "utf8"), "0");
  assert.equal(await stat(path.join(source, "mutated.txt")).catch(() => null), null);
  assert.equal(await stat(path.join(denied, "secret.txt")).catch(() => null), null);
  assert.equal(await readFile(path.join(output, "private-read.txt"), "utf8"), "");
  assert.notEqual((await stat(source)).mode & 0o200, 0);
});

test("Darwin provider maps Candidate output to a private target and exports matching owned evidence", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wechat-darwin-mount-")));
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  const owned = path.join(root, "owned");
  const mounted = path.join(source, "apps/mp/dist/build/mp-weixin");
  t.after(async () => {
    for (const directory of [source, path.join(source, "apps"), path.join(source, "apps/mp"), path.join(source, "apps/mp/dist"), path.join(source, "apps/mp/dist/build")]) {
      await chmod(directory, 0o700).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([mkdir(path.dirname(mounted), { recursive: true }), mkdir(output, { mode: 0o700 }), mkdir(owned, { mode: 0o700 })]);
  const session = provider.createSession({
    file: "/bin/sh", args: ["-c", `printf data > '${mounted}/app.js'`], cwd: source,
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    network: { mode: "deny-all", profileId: provider.profileId },
    filesystem: {
      readOnlyRoots: [source], writableRoots: [output], deniedRoots: [],
      mounts: [{ sourcePath: mounted, targetPath: output, mode: "candidate-output" }],
    },
    processGroup: { detached: true, terminateOnFailure: true, awaitExit: true },
    implementationId: provider.implementationId,
  });
  assert.deepEqual(await session.start(), { exitCode: 0 });
  await session.wait();
  const exported = await session.exportArtifact({ ownedArtifactRoot: owned });
  const entries = await exported.readFiles();
  assert.deepEqual(entries.map(({ relative, content }) => [relative, content.toString("utf8")]), [["app.js", "data"]]);
  assert.equal(exported.artifactSize, 4);
  assert.match(exported.artifactDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(path.dirname(path.dirname(exported.artifactPath)), owned);
  assert.equal(await stat(mounted).catch(() => null), null);
  assert.notEqual((await stat(source)).mode & 0o200, 0);
});

test("Darwin provider restores its read-only tree and mount when startup validation fails", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wechat-darwin-start-failure-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  const mounted = path.join(source, "build/output");
  await Promise.all([mkdir(path.dirname(mounted), { recursive: true }), mkdir(output, { mode: 0o700 })]);
  const session = provider.createSession({
    file: "/bin/true", args: [], cwd: source, env: { PATH: "/usr/bin:/bin" },
    network: { mode: "allow", profileId: provider.profileId },
    filesystem: { readOnlyRoots: [source], writableRoots: [output], deniedRoots: [], mounts: [{ sourcePath: mounted, targetPath: output, mode: "candidate-output" }] },
    processGroup: { detached: true, terminateOnFailure: true, awaitExit: true }, implementationId: provider.implementationId,
  });
  await assert.rejects(session.start(), /deny-all/i);
  assert.equal(await stat(mounted).catch(() => null), null);
  assert.notEqual((await stat(source)).mode & 0o200, 0);
});

test("production WeChat stage runner is unavailable until an explicit fixed command is configured", async () => {
  await assert.rejects(stageRunner({ stage: "upload" }), /not configured|unavailable/i);
});

test("production WeChat stage runner accepts only explicit zero-exit bounded JSON evidence", async () => {
  const command = [process.execPath, "-e", "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const v=JSON.parse(input);process.stdout.write(JSON.stringify({authoritative:v.credentials.token==='private'&&v.stage==='readUpload'}))})"];
  const request = {
    stage: "readUpload", credentials: { token: "private" }, evidence: { uploadId: "upload-1" },
    reviewConfiguration: { category: "Education", commands: { readUpload: command } },
  };
  assert.deepEqual(await stageRunner(request), { authoritative: true });
  await assert.rejects(stageRunner(request, { runCommand: async () => ({ stdout: "{}" }) }), /exit code|completion/i);
});

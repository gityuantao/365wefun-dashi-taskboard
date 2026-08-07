import assert from "node:assert/strict";
import test from "node:test";
import {
  closeTaskPullRequest,
  createPullRequest,
  deleteRemoteTaskBranch,
  resolveRemoteRepo,
} from "../../orchestration/git/pr.mjs";

function fakeRun(script) {
  const calls = [];
  return {
    calls,
    run: async (command, args) => {
      calls.push([command, args]);
      return script(command, args);
    },
  };
}

test("reuses an existing pull request instead of failing", async (t) => {
  const { run, calls } = fakeRun(() => ({
    status: 0,
    stdout: "https://github.com/gityuantao/365wefun/pull/861\n",
    stderr: "",
  }));
  const result = await createPullRequest({
    branch: "task/task-1",
    base: "version/1.0.1",
    title: "Task task-1: x",
    body: "y",
    run,
  });
  assert.equal(result.url, "https://github.com/gityuantao/365wefun/pull/861");
  assert.equal(result.alreadyExists, true);
  assert.ok(calls.every(([command, args]) => command === "gh" && !args.includes("create")));
});

test("creates a pull request when none exists", async (t) => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (args.includes("view")) {
      return { status: 1, stdout: "", stderr: "not found" };
    }
    return { status: 0, stdout: "https://github.com/gityuantao/365wefun/pull/900\n", stderr: "" };
  };
  const result = await createPullRequest({
    branch: "task/task-2",
    base: "version/1.0.1",
    title: "Task task-2: x",
    body: "y",
    run,
  });
  assert.equal(result.url, "https://github.com/gityuantao/365wefun/pull/900");
  assert.equal(result.alreadyExists, false);
  assert.ok(calls.some(([command, args]) => command === "gh" && args.includes("pr") && args.includes("create")));
});

test("recovers the existing PR url from a create failure", async (t) => {
  const run = async (command, args) => {
    if (args.includes("view")) {
      return { status: 1, stdout: "", stderr: "not found" };
    }
    return {
      status: 1,
      stdout: "",
      stderr: 'a pull request for branch "task/task-3" into branch "version/1.0.1" already exists:\nhttps://github.com/gityuantao/365wefun/pull/123',
    };
  };
  const result = await createPullRequest({
    branch: "task/task-3",
    base: "version/1.0.1",
    title: "x",
    body: "y",
    run,
  });
  assert.equal(result.url, "https://github.com/gityuantao/365wefun/pull/123");
  assert.equal(result.alreadyExists, true);
});

test("surfaces real create failures", async (t) => {
  const run = async (command, args) => {
    if (args.includes("view")) return { status: 1, stdout: "", stderr: "not found" };
    return { status: 1, stdout: "", stderr: "graphql: bad credentials" };
  };
  await assert.rejects(
    createPullRequest({ branch: "task/task-4", base: "main", title: "x", body: "y", run }),
    /bad credentials/,
  );
});

test("closeTaskPullRequest closes the PR and ignores already-closed", async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.equal(await closeTaskPullRequest({ branch: "task/t-1", repo: "o/r", run }), true);
  assert.ok(calls.some(([, args]) => args.includes("close") && args.includes("task/t-1")));
  const already = async () => ({ status: 1, stdout: "", stderr: "no open pull requests found for branch" });
  assert.equal(await closeTaskPullRequest({ branch: "task/t-2", repo: "o/r", run: already }), false);
});

test("deleteRemoteTaskBranch deletes and ignores missing branches", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.equal(deleteRemoteTaskBranch({ repoPath: "/r", branch: "task/t-3", run }), true);
  assert.ok(calls.some(([, args]) => args.includes("push") && args.includes("--delete")));
  const missing = () => ({ status: 1, stdout: "", stderr: "remote ref does not exist" });
  assert.equal(deleteRemoteTaskBranch({ repoPath: "/r", branch: "task/t-4", run: missing }), false);
});

test("resolveRemoteRepo parses the github origin", () => {
  const run = () => ({ status: 0, stdout: "git@github.com:gityuantao/365wefun.git\n", stderr: "" });
  assert.equal(resolveRemoteRepo("/r", run), "gityuantao/365wefun");
});

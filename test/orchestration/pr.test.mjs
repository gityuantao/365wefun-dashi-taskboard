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
    stdout: JSON.stringify({
      url: "https://github.com/gityuantao/365wefun/pull/861",
      state: "OPEN",
      baseRefName: "version/1.0.1",
    }),
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

test("creates a new pull request when the previous branch PR is already merged", async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args.includes("view")) {
      const requestedFields = args[args.indexOf("--json") + 1] ?? "";
      if (!requestedFields.includes("state")) {
        return {
          status: 0,
          stdout: "https://github.com/gityuantao/365wefun/pull/881\n",
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          url: "https://github.com/gityuantao/365wefun/pull/881",
          state: "MERGED",
          baseRefName: "version/v1.0.3",
        }),
        stderr: "",
      };
    }
    return {
      status: 0,
      stdout: "https://github.com/gityuantao/365wefun/pull/887\n",
      stderr: "",
    };
  };

  const result = await createPullRequest({
    branch: "task/86d3xmaw8",
    base: "version/v1.0.3",
    title: "返工修复",
    body: "最新验收反馈",
    run,
  });

  assert.deepEqual(result, {
    url: "https://github.com/gityuantao/365wefun/pull/887",
    alreadyExists: false,
  });
  assert.ok(calls.some((args) => args.includes("create")));
});

test("reuses the merged PR when the branch has no commits beyond the base", async () => {
  const run = async (_command, args) => {
    if (args.includes("view")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          url: "https://github.com/gityuantao/365wefun/pull/891",
          state: "MERGED",
          baseRefName: "version/v1.0.3",
        }),
        stderr: "",
      };
    }
    return {
      status: 1,
      stdout: "",
      stderr: "GraphQL: No commits between version/v1.0.3 and task/86d3xmaw8 (createPullRequest)",
    };
  };

  const result = await createPullRequest({
    branch: "task/86d3xmaw8",
    base: "version/v1.0.3",
    title: "部署失败重试",
    body: "没有新的代码改动",
    run,
  });

  assert.deepEqual(result, {
    url: "https://github.com/gityuantao/365wefun/pull/891",
    alreadyExists: true,
  });
});

test("createPullRequest rechecks fencing after view and before create mutation", async () => {
  let active = true;
  let mutations = 0;
  const run = async (_command, args) => {
    if (args.includes("view")) {
      active = false;
      return { status: 1, stdout: "", stderr: "not found" };
    }
    if (args.includes("create")) mutations += 1;
    return { status: 0, stdout: "https://example.test/pull/1", stderr: "" };
  };

  await assert.rejects(
    createPullRequest({
      branch: "task/fenced",
      base: "main",
      title: "fenced",
      body: "fenced",
      run,
      beforeMutation: async () => {
        if (!active) throw new Error("CLAIM_MISMATCH");
      },
    }),
    /CLAIM_MISMATCH/,
  );
  assert.equal(mutations, 0);
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

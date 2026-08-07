import { execFileSync } from "node:child_process";

function runCommand(command, args) {
  try {
    const stdout = execFileSync(command, args, { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout ? String(error.stdout) : "",
      stderr: error.stderr ? String(error.stderr) : "",
    };
  }
}

const URL_PATTERN = /https?:\/\/[^\s]+/;

const DEFAULT_REPO = "gityuantao/365wefun";

export function resolveRemoteRepo(repoPath, run = runCommand) {
  const remote = run("git", ["-C", repoPath, "remote", "get-url", "origin"]);
  if (remote.status === 0) {
    const match = remote.stdout.trim().match(/(?:github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return DEFAULT_REPO;
}

export async function closeTaskPullRequest({ branch, repo = DEFAULT_REPO, run = runCommand }) {
  const result = await run("gh", ["pr", "close", branch, "--repo", repo]);
  if (result.status !== 0 && !/no open pull requests/i.test(result.stderr)) {
    throw new Error(result.stderr.trim() || "gh pr close failed");
  }
  return result.status === 0;
}

export function deleteRemoteTaskBranch({ repoPath, branch, run = runCommand }) {
  const result = run("git", ["-C", repoPath, "push", "origin", "--delete", branch]);
  if (result.status !== 0 && !/remote ref does not exist|couldn't find remote ref/i.test(result.stderr)) {
    throw new Error(result.stderr.trim() || "remote branch delete failed");
  }
  return result.status === 0;
}

export async function createPullRequest({
  branch,
  base,
  title,
  body,
  repo = "gityuantao/365wefun",
  run = runCommand,
}) {
  const view = await run("gh", [
    "pr", "view",
    branch,
    "--repo", repo,
    "--json", "url",
    "--jq", ".url",
  ]);
  if (view.status === 0 && /^https?:/.test(view.stdout.trim())) {
    return { url: view.stdout.trim(), alreadyExists: true };
  }

  const created = await run("gh", [
    "pr", "create",
    "--repo", repo,
    "--base", base,
    "--head", branch,
    "--title", title,
    "--body", body,
  ]);
  if (created.status === 0) {
    return { url: created.stdout.trim(), alreadyExists: false };
  }

  const match = created.stderr.match(URL_PATTERN);
  if (/already exists/i.test(created.stderr) && match) {
    return { url: match[0].replace(/[),.;]*$/, ""), alreadyExists: true };
  }
  throw new Error(created.stderr.trim() || "gh pr create failed");
}

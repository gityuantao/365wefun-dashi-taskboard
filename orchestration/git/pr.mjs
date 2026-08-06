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

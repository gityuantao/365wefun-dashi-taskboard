import { fieldConfig } from "../clickup/config-registry.mjs";
import {
  bumpVersion,
  maxVersionName,
  parseVersion,
} from "../release/version-utils.mjs";

const TERMINAL_VERSION_STATUSES = new Set(["已发布", "已取消"]);

function targetVersionOf(task, config, taskListKey) {
  const field = fieldConfig(config, taskListKey, "目标版本");
  return task.custom_fields?.find(
    (candidate) => candidate.id === field.id || candidate.name === "目标版本",
  )?.value ?? null;
}

function extractJson(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return stdout;
  return stdout.slice(start, end + 1);
}

export async function assignTaskVersion({
  taskId,
  client,
  config,
  taskListKey,
  versionListKey,
  codex,
  now,
  log = () => {},
}) {
  const task = await client.getTask(taskId);
  const versionField = fieldConfig(config, taskListKey, "目标版本");
  const existing = targetVersionOf(task, config, taskListKey);
  if (existing) return { versionName: existing, created: false, assigned: false };

  const versions = await client.getVersionsByList(config.lists[versionListKey].id);
  const unreleased = versions.filter(
    (version) => !TERMINAL_VERSION_STATUSES.has(version.status?.status),
  );
  let versionName;
  let created = false;

  if (unreleased.length === 1) {
    versionName = unreleased[0].name;
  } else if (unreleased.length === 0) {
    const latest = maxVersionName(versions.map((version) => version.name));
    versionName = bumpVersion(latest);
    await client.createTask(config.lists[versionListKey].id, {
      name: versionName,
      description: `自动创建的下一个版本（基于 ${latest}）`,
      status: "进行中",
    });
    created = true;
  } else {
    versionName = await decideVersionByAI(task, unreleased, codex);
    if (!versionName) {
      return { versionName: null, created: false, assigned: false, error: "version decision failed" };
    }
  }

  await client.updateCustomField(taskId, versionField.id, versionName);
  log(`assigned task ${taskId} to version ${versionName}${created ? " (created)" : ""}`);
  return { versionName, created, assigned: true };
}

async function decideVersionByAI(task, unreleased, codex) {
  const prompt = [
    "你是版本规划器。根据任务内容和所有未发布版本信息，决定该任务应在哪个版本上线。",
    `任务名称：${task.name ?? ""}`,
    `任务描述：${task.description ?? ""}`,
    "未发布版本：",
    ...unreleased.map((version) => (
      `- ${version.name}: ${(version.description ?? "").slice(0, 120)}`
    )),
    "输出严格 JSON：{ \"version\": \"你选择的版本名\" }，不要输出其他文字。",
  ].join("\n");
  const run = await codex.run({ prompt, taskId: task.id });
  if (run.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(extractJson(run.stdout));
    if (typeof parsed.version !== "string" || parsed.version === "") return null;
    return parsed.version;
  } catch {
    return null;
  }
}

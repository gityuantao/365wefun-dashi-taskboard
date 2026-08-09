import { fieldConfig } from "../clickup/config-registry.mjs";
import {
  targetVersionName,
} from "./version-gate.mjs";

const TERMINAL_VERSION_STATUSES = new Set(["已发布", "已取消"]);

function targetVersionOf(task, config, taskListKey) {
  const field = fieldConfig(config, taskListKey, "目标版本");
  return targetVersionName(task.custom_fields?.find(
    (candidate) => candidate.id === field.id || candidate.name === "目标版本",
  )?.value ?? null);
}

export async function assignTaskVersion({
  taskId,
  client,
  config,
  taskListKey,
  versionListKey,
  codex,
  log = () => {},
  task: suppliedTask,
  versions: suppliedVersions,
}) {
  const task = suppliedTask ?? await client.getTask(taskId);
  const versionField = fieldConfig(config, taskListKey, "目标版本");
  const existing = targetVersionOf(task, config, taskListKey);
  if (existing) return { versionName: existing, created: false, assigned: false };

  const versions = suppliedVersions
    ?? await client.getVersionsByList(config.lists[versionListKey].id);
  const unreleased = versions.filter(
    (version) => !TERMINAL_VERSION_STATUSES.has(version.status?.status),
  );
  if (unreleased.length === 0) {
    return {
      versionName: null,
      created: false,
      assigned: false,
      error: "no current development version",
    };
  }
  const versionName = await decideVersionByAI(task, unreleased, codex);
  if (!versionName) {
    return {
      versionName: null,
      created: false,
      assigned: false,
      error: "version decision failed",
    };
  }
  const versionTaskId = unreleased.find((version) => version.name === versionName)?.id ?? null;

  if (!versionTaskId) {
    return { versionName, created: false, assigned: false, error: `version task not found: ${versionName}` };
  }

  // 目标版本 是 list_relationship 类型，ClickUp 要求 value 为 { add: [任务ID], rem: [] }
  await client.updateCustomField(taskId, versionField.id, { add: [versionTaskId], rem: [] });
  log(`assigned task ${taskId} to AI-selected version ${versionName} (${versionTaskId})`);
  return { versionName, created: false, assigned: true };
}

function extractJson(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return stdout;
  return stdout.slice(start, end + 1);
}

async function decideVersionByAI(task, unreleased, codex) {
  if (!codex || typeof codex.run !== "function") return null;
  const prompt = [
    "你是版本规划器。根据任务内容和所有未发布版本信息，决定该任务应在哪个版本上线。",
    `任务名称：${task.name ?? ""}`,
    `任务描述：${task.description ?? ""}`,
    "未发布版本：",
    ...unreleased.map((version) => (
      `- ${version.name}: ${(version.description ?? "").slice(0, 120)}`
    )),
    "只能选择上述版本之一。输出严格 JSON：{ \"version\": \"版本名\" }，不要输出其他文字。",
  ].join("\n");
  const run = await codex.run({ prompt, taskId: task.id });
  if (run.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(extractJson(run.stdout));
    if (typeof parsed.version !== "string" || parsed.version === "") return null;
    return unreleased.some((version) => version.name === parsed.version)
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

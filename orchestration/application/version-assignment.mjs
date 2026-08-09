import { fieldConfig } from "../clickup/config-registry.mjs";
import {
  resolveCurrentDevVersionName,
  targetVersionName,
} from "./version-gate.mjs";

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
  const versionName = resolveCurrentDevVersionName(versions);
  if (!versionName) {
    return {
      versionName: null,
      created: false,
      assigned: false,
      error: "no current development version",
    };
  }
  const versionTaskId = versions.find((version) => version.name === versionName)?.id ?? null;

  if (!versionTaskId) {
    return { versionName, created: false, assigned: false, error: `version task not found: ${versionName}` };
  }

  // 目标版本 是 list_relationship 类型，ClickUp 要求 value 为 { add: [任务ID], rem: [] }
  await client.updateCustomField(taskId, versionField.id, { add: [versionTaskId], rem: [] });
  log(`assigned task ${taskId} to current development version ${versionName} (${versionTaskId})`);
  return { versionName, created: false, assigned: true };
}

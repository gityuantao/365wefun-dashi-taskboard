import { compareVersions } from "../release/version-utils.mjs";
import { fieldConfig } from "../clickup/config-registry.mjs";

const TERMINAL_VERSION_STATUSES = new Set(["已发布", "已取消"]);

/**
 * 当前开发版本 = 所有未发布版本中版本号最小的一个。
 * 版本号小的版本必须先开发完并发布，之后才允许处理下一个版本的任务。
 * 没有未发布版本时返回 null。
 */
export function resolveCurrentDevVersionName(versions) {
  const unreleased = (versions ?? []).filter(
    (version) => !TERMINAL_VERSION_STATUSES.has(version.status?.status),
  );
  if (unreleased.length === 0) return null;
  unreleased.sort((left, right) => compareVersions(left.name, right.name));
  return unreleased[0].name;
}

/**
 * 任务版本门禁：
 * - 任务没有目标版本：放行（分析阶段会先确定并分配版本）；
 * - 任务目标版本 === 当前开发版本：放行；
 * - 其他情况：阻塞，不对该任务做分析/开发/测试/验收等任何操作，
 *   直到其所属版本成为当前开发版本。
 */
export function checkTaskVersionGate({ targetVersion, currentDevVersion }) {
  if (!targetVersion) {
    return { blocked: false, reason: null, waitingFor: null };
  }
  if (!currentDevVersion) {
    return {
      blocked: true,
      reason: `任务属于版本 ${targetVersion}，但当前没有未发布版本`,
      waitingFor: targetVersion,
    };
  }
  if (String(targetVersion).trim() !== String(currentDevVersion).trim()) {
    return {
      blocked: true,
      reason: `任务属于版本 ${targetVersion}，当前开发版本为 ${currentDevVersion}，需等待该版本发布`,
      waitingFor: targetVersion,
    };
  }
  return { blocked: false, reason: null, waitingFor: null };
}

export function targetVersionOfTask(task, config, taskListKey) {
  const field = fieldConfig(config, taskListKey, "目标版本");
  return task.custom_fields?.find(
    (candidate) => candidate.id === field.id || candidate.name === "目标版本",
  )?.value ?? null;
}

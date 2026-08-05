import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";

const DEVELOPED_STATES = new Set([
  "ready_for_test",
  "testing",
  "ready_for_acceptance",
  "accepting",
  "ready_for_release",
  "published",
  "canceled",
]);

function targetVersionOf(task) {
  return task.custom_fields?.find(
    (field) => field.name === "目标版本" || field.id === "field-version",
  )?.value ?? null;
}

function priorityOf(task) {
  return Number(task.priority?.priority ?? 3);
}

function isEarlier(left, right) {
  const leftPriority = priorityOf(left);
  const rightPriority = priorityOf(right);
  if (leftPriority !== rightPriority) return leftPriority < rightPriority;
  const leftCreated = new Date(left.date_created ?? 0).getTime();
  const rightCreated = new Date(right.date_created ?? 0).getTime();
  return leftCreated < rightCreated;
}

export async function checkDevelopmentOrder({
  db,
  taskId,
  client,
  listId,
  now,
}) {
  const task = await client.getTask(taskId);
  const versionName = targetVersionOf(task);
  if (!versionName) {
    return { blocked: true, reason: `task ${taskId} has no target version` };
  }
  const tasks = await client.getTasksByList(listId);
  const siblings = tasks.filter((candidate) => (
    candidate.id !== taskId && targetVersionOf(candidate) === versionName
  ));
  for (const sibling of siblings) {
    if (!isEarlier(sibling, task)) continue;
    const aggregate = await loadAggregate(db, "task", sibling.id);
    if (!DEVELOPED_STATES.has(aggregate.state ?? sibling.status)) {
      return {
        blocked: true,
        reason: `predecessor task ${sibling.id} has not finished development`,
      };
    }
  }
  return { blocked: false };
}

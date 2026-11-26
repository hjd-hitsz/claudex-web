import { createHash } from "node:crypto";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function traceId(id) {
  if (!id || id.length <= 8) return id;
  return uuid.test(id)
    ? id.slice(0, 8)
    : createHash("sha256").update(id).digest("hex").slice(0, 8);
}

export function traceMatches(entries, id, identify) {
  const exact = entries.filter((entry) => identify(entry) === id);
  return exact.length
    ? exact
    : entries.filter((entry) => traceId(identify(entry)) === id);
}

export function findDelegationTask(tasks, parent, id) {
  if (!id) return;
  const owned = Object.values(tasks).filter(
    (task) =>
      task.parentId === parent.id && task.sourceRuntime === parent.runtimeId,
  );
  const matches = traceMatches(owned, id, (task) => task.id);
  if (matches.length > 1)
    throw new Error("任务短 ID 有重复，请提供完整任务 ID");
  return matches[0];
}

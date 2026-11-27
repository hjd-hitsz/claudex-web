import { isCompacting } from "../../../shared/compaction-state.mjs";

export {
  isCompacting,
  recoverCompaction,
} from "../../../shared/compaction-state.mjs";

// 已结束的桥接记录仅更新页面正在跟踪的同一任务，避免恢复已收起的提示。
export function mergeCompactions(current, incoming = {}, live = false) {
  const entries = { ...current };
  for (const [threadId, entry] of Object.entries(incoming)) {
    const previous = current[threadId];
    const sameTask =
      previous &&
      (previous.id === entry.id ||
        (previous.turnId && previous.turnId === entry.turnId));
    if (sameTask && previous.dismissed) continue;
    if (
      isCompacting(entry) ||
      sameTask ||
      (live && entry.source === "automatic")
    )
      entries[threadId] = entry;
  }
  return entries;
}

import { isCompacting } from "../../shared/compaction-state.mjs";
import type {
  Compaction,
  CompactionTurn,
} from "../../shared/compaction-state.mjs";
import type { RequestId } from "./rpc-message.d.mts";
export { isCompacting } from "../../shared/compaction-state.mjs";

export type CompactionEntry = Compaction & { id: string };
type EventParams = {
  threadId?: string;
  turnId?: string;
  turn?: CompactionTurn;
  item?: { type: string };
};

// 手动整理的 RPC 响应仅确认提交；轮次结束才释放整理占用。
export function createCompactions(
  notify: (event: {
    method: "lan/compaction";
    params: { threadId: string; compaction: CompactionEntry };
  }) => void,
  now = () => Date.now() / 1000,
) {
  const entries = new Map<string, CompactionEntry>();
  function update(threadId: string, value: CompactionEntry) {
    entries.set(threadId, value);
    notify({
      method: "lan/compaction",
      params: { threadId, compaction: value },
    });
    return value;
  }
  function finish(
    threadId: string,
    status: CompactionEntry["status"],
    error?: string,
    completedAt = now(),
  ) {
    const entry = entries.get(threadId);
    if (!entry) return;
    return update(threadId, { ...entry, status, error, completedAt });
  }
  return {
    entries,
    update,
    finish,
    busy: (threadId?: string) =>
      threadId !== undefined && isCompacting(entries.get(threadId)),
    start(threadId: string, id: RequestId) {
      return update(threadId, {
        id: String(id),
        status: "starting",
        startedAt: now(),
      });
    },
    reject(threadId: string, id: RequestId, error: string) {
      const entry = entries.get(threadId);
      if (entry?.id === String(id) && isCompacting(entry))
        finish(threadId, "failed", error);
    },
    event(method: string, p: EventParams) {
      const threadId = p.threadId;
      if (threadId === undefined) return;
      const entry = entries.get(threadId);
      if (!isCompacting(entry)) return;
      if (
        method === "turn/started" &&
        p.turn &&
        entry.status === "starting" &&
        !entry.turnId
      )
        update(threadId, { ...entry, turnId: p.turn.id, status: "running" });
      if (
        (method === "item/started" || method === "item/completed") &&
        p.item?.type === "contextCompaction" &&
        (!entry.turnId || entry.turnId === p.turnId)
      )
        update(threadId, { ...entry, turnId: p.turnId, status: "running" });
      if (method === "turn/completed" && p.turn && entry.turnId === p.turn.id) {
        const status =
          p.turn.status === "completed"
            ? "completed"
            : p.turn.status === "interrupted"
              ? "interrupted"
              : "failed";
        finish(
          threadId,
          status,
          p.turn.error?.message,
          p.turn.completedAt ?? now(),
        );
      }
      if (method === "thread/closed")
        update(threadId, {
          ...entry,
          status: "reconnecting",
          error: "整理订阅已关闭，需要重新核对任务状态。",
        });
    },
    disconnected() {
      for (const [threadId, entry] of entries)
        if (isCompacting(entry))
          update(threadId, {
            ...entry,
            status: "reconnecting",
            error: "与 Codex 后端的连接中断，正在确认整理结果。",
          });
    },
  };
}

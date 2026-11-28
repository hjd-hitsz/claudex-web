import { randomUUID } from "node:crypto";

const maximumSnapshots = 8;
const idleTimeout = 30000;
const snapshotCursor = /^history:([\da-f-]{36}):(\d+)$/;

export function createHistoryPages(readHistory, page) {
  const snapshots = new Map();
  let closed = false;

  function release(id) {
    clearTimeout(snapshots.get(id)?.timer);
    snapshots.delete(id);
  }

  function retain(id, snapshot) {
    if (closed) return;
    release(id);
    snapshot.timer = setTimeout(() => release(id), idleTimeout);
    snapshot.timer.unref();
    snapshots.set(id, snapshot);
    if (snapshots.size > maximumSnapshots)
      release(snapshots.keys().next().value);
  }

  return {
    async read(method, params) {
      const cursor = snapshotCursor.exec(params.cursor || "");
      let id = cursor?.[1];
      const cached = snapshots.get(id);
      const { threadId, sortDirection } = params;
      if (
        cached &&
        (cached.threadId !== threadId ||
          cached.method !== method ||
          cached.sortDirection !== sortDirection)
      )
        throw new Error("分页位置无效");
      const snapshot = cached || {
        threadId,
        method,
        sortDirection,
        history: Promise.resolve(readHistory(threadId)).then((history) => {
          const { turns, compactCount } = Array.isArray(history)
            ? { turns: history }
            : history;
          return method === "thread/items/list"
            ? {
                records: turns.flatMap((turn) =>
                  (turn.items || []).map((item) => ({ turnId: turn.id, item })),
                ),
              }
            : { records: turns, compactCount };
        }),
      };
      if (!cached) id = randomUUID();
      retain(id, snapshot);
      try {
        const { records, compactCount } = await snapshot.history;
        const result = {
          ...page(records, { ...params, cursor: cursor?.[2] ?? params.cursor }),
          ...(compactCount != null && { compactCount }),
        };
        if (result.nextCursor)
          return {
            ...result,
            nextCursor: `history:${id}:${result.nextCursor}`,
          };
        if (!cached) release(id);
        return result;
      } catch (error) {
        release(id);
        throw error;
      }
    },
    invalidate(threadId) {
      for (const [id, snapshot] of snapshots)
        if (snapshot.threadId === threadId) release(id);
    },
    close() {
      closed = true;
      for (const id of snapshots.keys()) release(id);
    },
  };
}

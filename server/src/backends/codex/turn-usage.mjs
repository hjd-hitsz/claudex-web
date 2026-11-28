import { readRolloutTrace } from "./rollout-tools.mjs";

function difference(total, baseline) {
  return Object.fromEntries(
    Object.entries(total).flatMap(([field, count]) =>
      Number.isSafeInteger(count) &&
      Number.isSafeInteger(baseline?.[field]) &&
      count >= baseline[field]
        ? [[field, count - baseline[field]]]
        : [],
    ),
  );
}

export function createCodexTurnUsage(call) {
  const readThread = async (threadId) =>
    (await call("thread/read", { threadId, includeTurns: false })).thread;

  async function readUsage(threadId, ids = new Set()) {
    const order = new Map();
    const visited = new Set([threadId]);
    const compactions = new Map();
    let previous;
    const usage = {
      async readBase({ thread_id, end_byte_offset }) {
        if (!thread_id || visited.has(thread_id)) return new Map();
        visited.add(thread_id);
        return readRolloutTrace(await readThread(thread_id), ids, null, {
          usage,
          endByteOffset: end_byte_offset,
        });
      },
      compacted(id) {
        compactions.set(id, (compactions.get(id) ?? 0) + 1);
      },
      observe(id, tokenUsage) {
        if (id && !order.has(id))
          order.set(id, { turnNumber: order.size + 1, baseline: previous });
        const turn = order.get(id);
        if (tokenUsage) {
          previous = tokenUsage.total;
          if (turn)
            turn.tokenUsage = {
              ...tokenUsage,
              turnId: id,
              round: difference(previous, turn.baseline),
            };
        }
        if (turn)
          return { turnNumber: turn.turnNumber, tokenUsage: turn.tokenUsage };
      },
      rollback(count) {
        if (!Number.isSafeInteger(count) || count <= 0) return [];
        const retained = [...order.keys()];
        const removed = retained.splice(Math.max(0, retained.length - count));
        for (const id of removed) {
          order.delete(id);
          compactions.delete(id);
        }
        return removed;
      },
    };
    const turns = await readRolloutTrace(
      await readThread(threadId),
      ids,
      null,
      {
        usage,
      },
    );
    const compactCount = [...compactions.values()].reduce(
      (sum, n) => sum + n,
      0,
    );
    return { turns, compactCount };
  }

  return {
    async project(threadId, result) {
      if (!threadId || !Array.isArray(result?.data)) return result;
      if (!result.data.length && !result.nextCursor && !result.backwardsCursor)
        return { ...result, compactCount: 0 };
      try {
        const { turns, compactCount } = await readUsage(
          threadId,
          new Set(result.data.map(({ id }) => id)),
        );
        return {
          ...result,
          compactCount,
          data: result.data.map((turn) => ({ ...turn, ...turns.get(turn.id) })),
        };
      } catch (error) {
        console.error("读取 Codex 逐轮 Token 用量失败", error.message);
        return result;
      }
    },
    async compactionCount(threadId) {
      return (await readUsage(threadId)).compactCount;
    },
  };
}

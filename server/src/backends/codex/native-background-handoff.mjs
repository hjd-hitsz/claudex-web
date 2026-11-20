import { taskRequest } from "../../../../packages/background-terminal/client.mjs";

export function createNativeBackgroundHandoff({
  background,
  enabled,
  upstream,
  onSettled,
}) {
  const turns = new Map();
  const pending = new Map();
  const expectedUpstream = new URL(upstream).href;

  function event({ method, params }) {
    const { threadId, turnId, item, turn } = params ?? {};
    if (method === "item/started" && enabled()) {
      if (
        item?.type !== "commandExecution" ||
        item.source !== "unifiedExecStartup" ||
        !item.processId
      )
        return;
      if (!turns.has(turnId)) turns.set(turnId, { threadId, items: new Map() });
      turns.get(turnId).items.set(item.id, {
        id: item.id,
        processId: item.processId,
        command: item.command,
        cwd: item.cwd,
        startedAtMs: item.startedAtMs ?? params.startedAtMs,
      });
    } else if (method === "item/completed") {
      turns.get(turnId)?.items.delete(item?.id);
    } else if (method === "turn/completed") {
      const record = turns.get(turn.id);
      turns.delete(turn.id);
      if (!record?.items.size || turn.status !== "completed" || !enabled())
        return;
      if (!pending.has(threadId)) pending.set(threadId, new Set());
      const requests = pending.get(threadId);
      const work = background
        .ensure()
        .then((directory) =>
          taskRequest(directory, "watchNative", {
            threadId,
            turnId: turn.id,
            items: [...record.items.values()],
            expectedUpstream,
          }),
        )
        .catch((error) =>
          console.error("订阅 Codex 原生后台终端", threadId, error.message),
        )
        .finally(() => {
          requests.delete(work);
          if (!requests.size) pending.delete(threadId);
          onSettled();
        });
      requests.add(work);
    } else if (
      ["thread/closed", "thread/archived", "thread/deleted"].includes(method)
    ) {
      for (const [id, record] of turns)
        if (record.threadId === threadId) turns.delete(id);
    }
  }

  return {
    event,
    pending: (threadId) => pending.has(threadId),
    wait: (threadId) => Promise.all(pending.get(threadId) ?? []),
    disconnected: () => turns.clear(),
  };
}

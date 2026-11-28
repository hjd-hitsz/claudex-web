import { taskRequest } from "../../../../packages/background-terminal/client.mjs";
import type { NativeEvent } from "./native-protocol.d.mts";
import type { createBackgroundService } from "./background-service.mjs";

type NativeCommand = {
  id: string;
  processId: string;
  command: unknown;
  cwd: unknown;
  startedAtMs: unknown;
};

export function createNativeBackgroundHandoff({
  background,
  enabled,
  upstream,
  onSettled,
}: {
  background?: Pick<ReturnType<typeof createBackgroundService>, "available"> & {
    ensure(): Promise<string>;
  };
  enabled: (threadId: string) => boolean;
  upstream: string;
  onSettled: () => void;
}) {
  const turns = new Map<
    string,
    { threadId: string; items: Map<string, NativeCommand> }
  >();
  const pending = new Map<string, Set<Promise<unknown>>>();
  const expectedUpstream = new URL(upstream).href;

  function event({ method, params }: NativeEvent) {
    const { threadId, turnId, item, turn } = params ?? {};
    if (!threadId) return;
    if (method === "item/started" && turnId && enabled(threadId)) {
      if (
        item?.type !== "commandExecution" ||
        item.source !== "unifiedExecStartup" ||
        typeof item.processId !== "string" ||
        !item.processId
      )
        return;
      const record = turns.get(turnId) ?? {
        threadId,
        items: new Map<string, NativeCommand>(),
      };
      turns.set(turnId, record);
      record.items.set(item.id, {
        id: item.id,
        processId: item.processId,
        command: item.command,
        cwd: item.cwd,
        startedAtMs: item.startedAtMs ?? params?.startedAtMs,
      });
    } else if (method === "item/completed" && turnId && item) {
      turns.get(turnId)?.items.delete(item.id);
    } else if (method === "turn/completed" && turn) {
      const record = turns.get(turn.id);
      turns.delete(turn.id);
      if (
        !background ||
        !record?.items.size ||
        turn.status !== "completed" ||
        !enabled(threadId)
      )
        return;
      const requests = pending.get(threadId) ?? new Set<Promise<unknown>>();
      pending.set(threadId, requests);
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
        .catch((error: unknown) =>
          console.error(
            "订阅 Codex 原生后台终端",
            threadId,
            error instanceof Error ? error.message : String(error),
          ),
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
    pending: (threadId: string) => pending.has(threadId),
    wait: (threadId: string) => Promise.all(pending.get(threadId) ?? []),
    disconnected: () => turns.clear(),
  };
}

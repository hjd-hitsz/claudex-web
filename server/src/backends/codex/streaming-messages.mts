import type { NativeEvent, NativeEventParams } from "./native-protocol.d.mts";

type StreamingItem = NonNullable<NativeEventParams["item"]> & {
  turnId: string;
};

export function createStreamingMessages() {
  const threads = new Map<
    string,
    { turnId: string; items: Map<string, StreamingItem> }
  >();
  function event({ method, params = {} }: NativeEvent) {
    const { threadId, turnId, item, itemId, delta } = params;
    if (!threadId) return;
    if (
      [
        "thread/closed",
        "thread/archived",
        "thread/deleted",
        "turn/started",
      ].includes(method)
    ) {
      threads.delete(threadId);
      return;
    }
    const messages = threads.get(threadId);
    if (method === "turn/completed") {
      if (params.turn && messages?.turnId === params.turn.id)
        threads.delete(threadId);
      return;
    }
    if (method === "item/completed") {
      if (item && messages && messages.turnId === turnId)
        messages.items.delete(item.id);
      return;
    }
    if (method === "item/started" && item?.type === "userMessage") {
      if (!messages || messages.turnId !== turnId || !messages.items.size)
        return;
      // Codex 接收中途输入时，已取消的正文流可能缺少完成事件。
      threads.delete(threadId);
      return [...messages.items.keys()];
    }
    if (!turnId) return;
    const items =
      messages?.turnId === turnId
        ? messages.items
        : new Map<string, StreamingItem>();
    if (method === "item/started" && item?.type === "agentMessage") {
      items.set(item.id, { ...item, turnId });
    } else if (
      method === "item/agentMessage/delta" &&
      itemId &&
      typeof delta === "string"
    ) {
      const message = items.get(itemId) ?? {
        id: itemId,
        turnId,
        type: "agentMessage",
        text: "",
      };
      items.set(itemId, { ...message, text: (message.text ?? "") + delta });
    } else return;
    if (messages?.items !== items) threads.set(threadId, { turnId, items });
  }
  return {
    event,
    read: (threadId: string) => [
      ...(threads.get(threadId)?.items.values() ?? []),
    ],
    clear: () => threads.clear(),
  };
}

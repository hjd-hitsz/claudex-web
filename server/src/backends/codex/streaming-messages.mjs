export function createStreamingMessages() {
  const threads = new Map();
  function event({ method, params = {} }) {
    const { threadId, turnId, item, itemId, delta } = params;
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
      if (messages?.turnId === params.turn.id) threads.delete(threadId);
      return;
    }
    if (method === "item/completed") {
      if (messages?.turnId === turnId) messages.items.delete(item.id);
      return;
    }
    if (
      method !== "item/agentMessage/delta" &&
      !(method === "item/started" && item.type === "agentMessage")
    )
      return;
    if (!messages || messages.turnId !== turnId)
      threads.set(threadId, { turnId, items: new Map() });
    const { items } = threads.get(threadId);
    if (method === "item/started") {
      items.set(item.id, { ...item, turnId });
    } else {
      const message = items.get(itemId) ?? {
        id: itemId,
        turnId,
        type: "agentMessage",
        text: "",
      };
      items.set(itemId, { ...message, text: message.text + delta });
    }
  }
  return {
    event,
    read: (threadId) => [...(threads.get(threadId)?.items.values() ?? [])],
    clear: () => threads.clear(),
  };
}

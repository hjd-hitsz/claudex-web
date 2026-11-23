import { resourceTarget } from "../../../shared/backend-identity.mjs";

function readHistoryPage(rpc, method, params) {
  const streaming =
    !params.cursor && resourceTarget(params.threadId).backendId === "codex";
  return rpc(method, {
    ...params,
    ...(streaming && { includeStreaming: true }),
  });
}

export function historyPageReader({ rpc, get, set, current, firstPage }) {
  return async (method, params) => {
    const previous = get().items;
    const page =
      firstPage && method === "thread/items/list" && !params.cursor
        ? await firstPage()
        : await readHistoryPage(rpc, method, params);
    if (current() && page.streamingMessages) {
      const items = new Map(get().items.map((item) => [item.id, item]));
      const streamingIds = new Set(page.streamingMessages.map(({ id }) => id));
      // 首屏快照列出当前流式正文，断线前的片段由快照或原生历史接替。
      for (const item of previous)
        if (
          item.streaming &&
          !streamingIds.has(item.id) &&
          items.get(item.id) === item
        )
          items.delete(item.id);
      for (const item of page.streamingMessages)
        items.set(item.id, { ...item, streaming: true });
      if (items.size !== get().items.length || streamingIds.size)
        set({ items: [...items.values()] });
    }
    return page;
  };
}

export function prefetchThreadItems(rpc, threadId, get, turnRevisions) {
  const revision = turnRevisions.get(threadId);
  const unchanged = () =>
    !get().active?.[threadId] && turnRevisions.get(threadId) === revision;
  if (!unchanged()) return;
  const params = {
    threadId,
    limit: 100,
    sortDirection: "desc",
  };
  const fetch = () => readHistoryPage(rpc, "thread/items/list", params);
  const response = Promise.resolve()
    .then(fetch)
    .then(
      (page) => () => page,
      (error) => () => {
        throw error;
      },
    );
  return async () => {
    const result = await response;
    return unchanged() ? result() : fetch();
  };
}

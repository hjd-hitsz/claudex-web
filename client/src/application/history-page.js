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
    const page =
      firstPage && method === "thread/items/list" && !params.cursor
        ? await firstPage()
        : await readHistoryPage(rpc, method, params);
    if (current() && page.streamingMessages?.length) {
      const items = new Map(get().items.map((item) => [item.id, item]));
      // 快照包含响应前已收到的增量，衔接页面打开期间的流式正文。
      for (const item of page.streamingMessages) items.set(item.id, item);
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

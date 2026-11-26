import { readThreadHistory } from "../domain/thread-history.js";
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

export function createThreadHistoryLoader({
  rpc,
  get,
  set,
  transport,
  getConnectionRevision,
  historyRevision,
  opening,
}) {
  return async function loadHistory(
    epoch = opening(),
    { onFirstPage, firstPage } = {},
  ) {
    if (!get().current) return;
    const id = get().current.id;
    const connection = transport.connection;
    const revision = getConnectionRevision();
    const history = historyRevision();
    const previous = new Map(get().items.map((item) => [item.id, item]));
    const current = () =>
      history === historyRevision() &&
      epoch === opening() &&
      get().current?.id === id &&
      connection === transport.connection &&
      revision === getConnectionRevision() &&
      get().connected;
    function apply(history) {
      if (!current()) return;
      const map = new Map(history.map((item) => [item.id, item]));
      // 只让读取期间真正更新的记录覆盖历史；首屏快照仍属于本次读取。
      for (const item of get().items)
        if (!map.has(item.id) || previous.get(item.id) !== item)
          map.set(item.id, item);
      const items = [...map.values()];
      set({ items });
      for (const item of history)
        if (map.get(item.id) === item) previous.set(item.id, item);
    }
    const readPage = historyPageReader({ rpc, get, set, current, firstPage });
    const delegated =
      get().nativeDelegation && resourceTarget(id).backendId !== "agy"
        ? rpc("lan/delegation/tasks", { threadId: id }).then(
            ({ items }) => items,
          )
        : Promise.resolve([]);
    const [loaded, delegations] = await Promise.all([
      readThreadHistory(readPage, id, {
        current,
        ...(onFirstPage && {
          onFirstPage: (items) => {
            if (!current()) return;
            apply(items);
            onFirstPage();
          },
        }),
      }),
      delegated,
    ]);
    apply([...loaded, ...delegations]);
  };
}

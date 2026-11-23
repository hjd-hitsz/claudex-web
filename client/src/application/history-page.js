import { resourceTarget } from "../../../shared/backend-identity.mjs";

export function readHistoryPage(rpc, method, params) {
  const streaming =
    !params.cursor && resourceTarget(params.threadId).backendId === "codex";
  return rpc(method, {
    ...params,
    ...(streaming && { includeStreaming: true }),
  });
}

export function prefetchThreadItems(rpc, threadId, unchanged) {
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

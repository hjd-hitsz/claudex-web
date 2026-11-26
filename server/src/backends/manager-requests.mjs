import { resourceId } from "../../../shared/backend-identity.mjs";

export function createBackendRequests({
  send,
  tokenUsage,
  projectResult,
  settle,
}) {
  let sequence = 0;
  function proxy(entry, client) {
    if (!entry.proxies.has(client)) {
      const methods = new Map();
      entry.proxies.set(client, {
        get readyState() {
          return client.readyState;
        },
        methods,
        async deliver(message) {
          const { method, threadId, usageRevision, forkUsage, grant } =
            methods.get(message.id) || {};
          methods.delete(message.id);
          settle(grant, message);
          if (!message.error && method === "thread/delete")
            tokenUsage.remove(threadId);
          if (!message.error && method === "thread/archive")
            tokenUsage.archive(threadId);
          if (!message.error && method === "thread/unarchive")
            tokenUsage.archive(threadId, false);
          send(client, {
            ...message,
            ...(message.result && {
              result: await projectResult(
                entry,
                message.result,
                method,
                usageRevision,
                forkUsage,
              ),
            }),
          });
        },
      });
    }
    return entry.proxies.get(client);
  }
  function call(entry, method, params, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const usageRevision = tokenUsage.revision(
      params.threadId && resourceId(entry.backend.id, params.threadId),
    );
    return new Promise((resolve, reject) => {
      const id = `manager-${++sequence}`;
      const fail = (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error);
      };
      const abort = () => fail(signal.reason);
      const timer = setTimeout(() => fail(new Error("后端读取超时")), 120000);
      signal?.addEventListener("abort", abort, { once: true });
      const client = {
        readyState: 3,
        readOnly: Boolean(signal),
        async deliver(message) {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) return;
          try {
            if (message.error) reject(new Error(message.error.message));
            else
              resolve(
                await projectResult(
                  entry,
                  message.result,
                  method,
                  usageRevision,
                ),
              );
          } catch (error) {
            reject(error);
          }
        },
      };
      Promise.resolve(
        entry.adapter.receive(client, { id, method, params }),
      ).catch((error) => {
        fail(error);
      });
    });
  }

  return { proxy, call };
}

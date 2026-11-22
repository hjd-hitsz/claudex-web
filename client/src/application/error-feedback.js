import { RpcConnectionError } from "../infrastructure/rpc-client.js";

// 按操作和目标匹配重试，文件内容和消息正文可在重试前修改。
export function rpcFeedbackKey(method, params) {
  return JSON.stringify([
    method,
    params.backendId,
    params.providerId,
    params.threadId,
    params.turnId ?? params.expectedTurnId,
    params.path,
    params.cwd,
    params.id,
    params.processId,
    params.taskId,
    params.name,
    params.cursor,
  ]);
}

export function createErrorFeedback({ get, set, opening }) {
  const sources = new WeakMap();
  const latest = new Map();
  let scope;
  let visible;

  function start(key) {
    const epoch = opening();
    if (scope !== epoch) {
      scope = epoch;
      latest.clear();
    }
    const attempt = { key, epoch };
    latest.set(key, attempt);
    return attempt;
  }
  const current = (attempt) =>
    attempt.epoch === opening() && latest.get(attempt.key) === attempt;

  function resolve(attempt) {
    if (
      visible?.attempt?.key === attempt.key &&
      visible.attempt.epoch === attempt.epoch &&
      current(attempt) &&
      get().error === visible.message
    ) {
      visible = null;
      set({ error: "" });
    }
  }
  async function track(key, run) {
    const attempt = start(key);
    try {
      const result = await run();
      resolve(attempt);
      return result;
    } catch (error) {
      if (error instanceof Error && !sources.has(error))
        sources.set(error, attempt);
      throw error;
    }
  }
  function report(error, operation) {
    const cause = error?.cause ?? error;
    if (
      error?.archivedThreadId ||
      cause?.archivedThreadId ||
      cause instanceof RpcConnectionError
    )
      return;
    const source = sources.get(cause) ?? sources.get(error);
    const attempt = operation ?? source;
    if (attempt && !current(attempt)) return;
    const message = error?.message || String(error);
    visible = { attempt, message };
    set({ error: message, notice: "" });
  }
  function reset() {
    latest.clear();
    visible = null;
    if (get().error) set({ error: "" });
  }
  return { start, resolve, track, report, reset };
}

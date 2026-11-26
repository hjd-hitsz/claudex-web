import { join } from "node:path";
import { createStorage } from "../storage.mjs";

export const nowSeconds = () => Date.now() / 1000;

export function createAgyStore(directory) {
  const storage = createStorage(join(directory, "state.json"), {
    sessions: {},
    tasks: {},
    receipts: {},
    notices: {},
  });
  return {
    ...storage,
    async change(change) {
      let result;
      await storage.update((data) => {
        result = change(data);
        return data;
      });
      return result;
    },
    session(data, id) {
      const session = data.sessions[id];
      if (!session || session.deleted) throw new Error("agy 对话不存在");
      return session;
    },
  };
}

export function agyThread(session, active) {
  const {
    id,
    cwd,
    name,
    archived,
    createdAt,
    updatedAt,
    source,
    model,
    effort,
  } = session;
  return {
    id,
    cwd,
    name,
    createdAt,
    updatedAt,
    model,
    reasoningEffort: effort,
    tokenUsage: session.tokenUsage,
    parentThreadId: session.source?.threadId,
    threadSource: session.threadSource,
    originator: "claudex_web",
    preview: name || "新对话",
    path: archived ? "/archived_sessions/" : "",
    archived: Boolean(archived),
    status: { type: active ? "active" : "idle" },
  };
}

export function agyPage(values, { cursor, limit }, descending = true) {
  const offset = cursor == null ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("无效的 agy 分页位置");
  const size = Math.max(1, Math.min(Number(limit) || 50, 200));
  const data = (descending ? values.toReversed() : values).slice(
    offset,
    offset + size,
  );
  return {
    data,
    nextCursor:
      offset + data.length < values.length
        ? String(offset + data.length)
        : null,
  };
}

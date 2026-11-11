import { createHash } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createStorage } from "./backends/storage.mjs";

// 每个完整对话标识对应一个快照文件，读取和写入均只访问所属对话。
export function createTokenUsageStore(directory) {
  const entries = new Map();
  const pendingResults = new Set();
  function entry(threadId) {
    if (!entries.has(threadId)) {
      const name = createHash("sha256").update(threadId).digest("hex");
      const path = join(directory, "token-usage", `${name}.json`);
      const storage = createStorage(path, null);
      entries.set(threadId, {
        path,
        storage,
        revision: 0,
        value: undefined,
        turnId: null,
        loading: null,
        writing: null,
        deleted: false,
        archived: false,
        savedRevision: 0,
        error: null,
        importing: null,
      });
    }
    return entries.get(threadId);
  }
  async function read(threadId) {
    const state = entry(threadId);
    if (state.value !== undefined) return state.value;
    state.loading ||= state.storage
      .read()
      .then((saved) => {
        if (state.value === undefined) {
          state.value = saved?.threadId === threadId ? saved.tokenUsage : null;
          state.turnId = saved?.threadId === threadId ? saved.turnId : null;
        }
        return state.value;
      })
      .catch((error) => {
        state.loading = null;
        throw error;
      });
    return state.loading;
  }
  function write(threadId, state) {
    if (state.writing) return state.writing;
    const operation = (async () => {
      let revision;
      do {
        revision = state.revision;
        if (state.deleted || state.archived || state.value == null)
          await rm(state.path, { force: true });
        else {
          const snapshot = {
            threadId,
            tokenUsage: state.value,
            turnId: state.turnId,
            updatedAt: new Date().toISOString(),
          };
          await state.storage.replace(snapshot);
        }
        state.savedRevision = revision;
        state.error = null;
      } while (revision !== state.revision);
    })();
    state.writing = operation.finally(() => {
      state.writing = null;
    });
    state.writing.catch((error) => {
      state.error = error;
      console.error(`保存对话 ${threadId} token 用量失败：${error.message}`);
    });
    return state.writing;
  }
  function remember(threadId, tokenUsage, turnId) {
    if (!threadId || !tokenUsage) return;
    const state = entry(threadId);
    if (state.deleted || state.archived) return;
    const sameValue =
      JSON.stringify(state.value) === JSON.stringify(tokenUsage);
    const usageTurnId = turnId ?? (sameValue ? state.turnId : null);
    if (sameValue && state.turnId === usageTurnId) {
      if (state.savedRevision !== state.revision) write(threadId, state);
      return;
    }
    state.value = structuredClone(tokenUsage);
    state.turnId = usageTurnId;
    state.revision++;
    write(threadId, state);
  }
  function remove(threadId) {
    if (!threadId) return;
    const state = entry(threadId);
    state.deleted = true;
    state.value = null;
    state.revision++;
    write(threadId, state);
  }
  function archive(threadId, archived = true) {
    if (!threadId) return;
    const state = entry(threadId);
    state.archived = archived;
    state.value = null;
    state.revision++;
    if (archived) write(threadId, state);
  }
  async function project(result, method, revision, forkUsage, readNativeUsage) {
    if (
      !["thread/read", "thread/resume", "thread/fork"].includes(method) ||
      !result?.thread
    )
      return result;
    const thread = result.thread;
    if (thread.path?.includes("/archived_sessions/")) archive(thread.id);
    const state = entry(thread.id);
    if (state.deleted || state.archived) return result;
    try {
      await read(thread.id);
    } catch (error) {
      console.error(`读取对话 ${thread.id} token 用量失败：${error.message}`);
    }
    if (!state.value && !thread.tokenUsage && readNativeUsage) {
      try {
        state.importing ||= readNativeUsage(thread);
        const restored = await state.importing;
        if (
          !state.value &&
          !state.archived &&
          !state.deleted &&
          restored?.tokenUsage
        )
          remember(thread.id, restored.tokenUsage, restored.turnId);
      } catch (error) {
        state.importing = null;
        console.error(
          `首次补录对话 ${thread.id} token 用量失败：${error.message}`,
        );
      }
    }
    if (
      (thread.tokenUsage || forkUsage?.tokenUsage) &&
      state.revision === (method === "thread/fork" ? 0 : revision)
    )
      remember(
        thread.id,
        thread.tokenUsage || forkUsage.tokenUsage,
        forkUsage?.turnId,
      );
    const tokenUsage = state.value || thread.tokenUsage;
    return tokenUsage
      ? { ...result, thread: { ...thread, tokenUsage } }
      : result;
  }
  return {
    read,
    remember,
    remove,
    archive,
    async forkSource(params) {
      if (params.beforeTurnId || params.path || !params.threadId) return null;
      let tokenUsage;
      try {
        tokenUsage = await read(params.threadId);
      } catch (error) {
        console.error(
          `读取分支来源 ${params.threadId} token 用量失败：${error.message}`,
        );
        return null;
      }
      const state = entry(params.threadId);
      if (
        !tokenUsage ||
        (params.lastTurnId && params.lastTurnId !== state.turnId)
      )
        return null;
      return structuredClone({ tokenUsage, turnId: state.turnId });
    },
    revision: (threadId) => (threadId ? entry(threadId).revision : 0),
    revisions: () =>
      new Map([...entries].map(([id, state]) => [id, state.revision])),
    observe({ method, params }) {
      if (method === "thread/tokenUsage/updated")
        remember(params.threadId, params.tokenUsage, params.turnId);
      if (method === "thread/deleted") remove(params.threadId);
      if (method === "thread/archived") archive(params.threadId);
      if (method === "thread/unarchived") archive(params.threadId, false);
    },
    result(...params) {
      const operation = project(...params);
      pendingResults.add(operation);
      operation.then(
        () => pendingResults.delete(operation),
        () => pendingResults.delete(operation),
      );
      return operation;
    },
    async flush() {
      await Promise.allSettled([...pendingResults]);
      await Promise.all([...entries.values()].map((state) => state.writing));
      for (const state of entries.values()) if (state.error) throw state.error;
    },
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "../src/application/connection.js";

test("单个后端恢复触发所属对话后台恢复，其余后端的状态变化保持隔离", async (t) => {
  const original = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  t.after(() => {
    globalThis.localStorage = original;
  });
  const backends = (codex, claude) => [
    { id: "codex", ready: codex, enabled: true },
    { id: "claude", ready: claude, enabled: true },
  ];
  let state = {
    connected: true,
    backendId: "codex",
    backends: backends(false, true),
    current: { id: "thread" },
    questions: [],
    undoneFiles: {},
    compactions: {},
    cwd: "/demo",
    draft: "保留草稿",
    items: [{ id: "saved" }],
    usage: { remaining: 50 },
    loading: false,
  };
  const get = () => state,
    set = (patch) => {
      state = { ...state, ...patch };
    };
  const calls = [];
  const auxiliary = Promise.withResolvers();
  const connection = createConnection({
    get,
    set,
    rpc() {
      throw new Error("双后端初始化由所属控制器读取");
    },
    transport: {},
    models: {},
    records: {},
    navigation: {
      opening: 0,
      loadHistory: async () => calls.push("history"),
      refreshThreadAccess: async (options) => calls.push(options),
    },
    catalog: {
      async loadThreads() {
        calls.push("list");
        await auxiliary.promise;
      },
    },
    messages: {},
    account: { revision: 0, reset: () => calls.push("reset") },
    compaction: {},
    events: {},
    emit() {},
    report: (e) => {
      throw e;
    },
    loadSkills: async () => {},
    async activateBackend(id) {
      calls.push(id);
      await auxiliary.promise;
    },
  });
  const snapshot = (codex, claude) =>
    connection.onNotification({
      method: "lan/state",
      params: {
        ready: codex || claude,
        bridgeReady: true,
        backends: backends(codex, claude),
        defaultBackendId: "codex",
        questions: [],
        activeTurns: {},
        compactions: {},
      },
    });
  snapshot(true, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["codex", "list", "history", { background: true }]);
  assert.equal(state.draft, "保留草稿");
  assert.deepEqual(state.items, [{ id: "saved" }]);
  assert.deepEqual(state.usage, { remaining: 50 });
  auxiliary.resolve();
  calls.length = 0;
  snapshot(true, false);
  snapshot(true, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, []);
  snapshot(false, true);
  assert.deepEqual(calls, ["reset"]);
  assert.equal(state.connected, true);
  calls.length = 0;
  set({ current: null, draft: "" });
  storage.set("cx-draft-new", "未发送的共享输入");
  snapshot(true, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["codex", "list"]);
  assert.equal(state.draft, "未发送的共享输入");
});

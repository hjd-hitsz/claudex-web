import assert from "node:assert/strict";
import test from "node:test";
import { createBackends } from "../src/application/backends.js";
import { createErrorFeedback } from "../src/application/error-feedback.js";
import { createMessages } from "../src/application/messages.js";
import { createAppState } from "../src/application/state.js";
import { createThreadNavigation } from "../src/application/thread-navigation.js";
import { createThreadRecords } from "../src/application/thread-records.js";
import { codeLineAttachment } from "../src/domain/code-line-reference.js";
import { readNewDraft } from "../src/infrastructure/backend-storage.js";

function storageFixture(t, entries = []) {
  const original = globalThis.localStorage;
  const storage = new Map(entries);
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  t.after(() => (globalThis.localStorage = original));
  return storage;
}

test("旧版新建草稿合并一次，已存在的对话草稿独立保存", (t) => {
  const storage = storageFixture(t, [
    ["cx-draft-new", "Codex 草稿"],
    ["cx-draft-new-claude", "Claude 草稿\n\n第二段"],
    ["cx-draft-new-agy", "Antigravity 草稿"],
    ["cx-draft-thread", "已有对话"],
  ]);
  const merged = "Codex 草稿\n\nClaude 草稿\n\n第二段\n\nAntigravity 草稿";
  assert.equal(createAppState().get().draft, merged);
  assert.deepEqual(
    [...storage],
    [
      ["cx-draft-new", merged],
      ["cx-draft-thread", "已有对话"],
    ],
  );
  storage.set("cx-draft-new-claude", "Claude 草稿\n\n第二段");
  assert.equal(readNewDraft(), merged, "写入后中断的迁移可重试");
  storage.delete("cx-draft-new");
  assert.equal(readNewDraft(), "", "清空后旧草稿不再恢复");
});

function navigationFixture(t, onRpc) {
  const storage = storageFixture(t, [
    ["cx-draft-new", "共享输入"],
    ["cx-draft-original", "原对话输入"],
  ]);
  const store = createAppState();
  const { get, set } = store;
  set({
    connected: true,
    cwd: "/demo",
    current: { id: "original", delegationMode: true },
    draft: "原对话输入",
    nativeDelegation: true,
    backends: [
      { id: "codex", enabled: true, ready: true },
      { id: "claude", enabled: true, ready: true },
      {
        id: "agy",
        enabled: true,
        delegates: { codex: { enabled: true }, claude: { enabled: true } },
      },
    ],
  });
  const requests = [];
  const models = {
    defaults: {},
    disconnect() {},
    configure() {},
    rememberModelSelection() {},
    projectModelSelection: () => ({}),
  };
  const rpc = async (method, params) => {
    switch (method) {
      case "thread/start":
        requests.push(params);
        return {
          thread: {
            id: "created",
            cwd: params.cwd,
            delegationMode: params.delegationMode === true,
          },
        };
      case "thread/read":
      case "thread/resume":
        return { thread: { id: params.threadId, cwd: "/demo" } };
      case "lan/delegation/tasks":
        return { items: [] };
      case "thread/items/list":
      case "thread/turns/list":
      case "model/list":
        return { data: [] };
      case "lan/providers/list":
        return { providers: [] };
      case "account/read":
        return { account: null };
      case "config/read":
        return { config: {} };
      default:
        assert(onRpc, `意外请求 ${method}`);
        return onRpc(method, params);
    }
  };
  const records = createThreadRecords({ get, set, rpc });
  const report = (error) => {
    throw error;
  };
  const { activateBackend } = createBackends({ get, set, rpc, models, report });
  const navigation = createThreadNavigation({
    get,
    set,
    models,
    records,
    rpc,
    transport: {},
    getConnectionRevision: () => 0,
    activateBackend,
    report,
  });
  const messages = createMessages({
    ...store,
    rpc,
    models,
    navigation,
    records,
    catalog: { loadThreads: async () => {} },
    feedback: createErrorFeedback({
      get,
      set,
      opening: () => navigation.opening,
    }),
  });
  function switchBackend(backendId) {
    navigation.newChat(undefined, { backendId, applyModelSelection: false });
    return activateBackend(backendId);
  }
  return {
    get,
    set,
    storage,
    requests,
    ...navigation,
    messages,
    switchBackend,
  };
}

test("新建与 Codex、Claude 切换继承委派，首轮创建时迁移共享草稿", async (t) => {
  const { get, set, storage, requests, newChat, ensureThread } =
    navigationFixture(t);
  newChat();
  assert.equal(get().delegationMode, true);
  assert.equal(get().draft, "共享输入");
  newChat(undefined, { backendId: "claude" });
  set({ backendId: "claude" });
  assert.equal(get().delegationMode, true);
  assert.equal(get().draft, "共享输入");
  await ensureThread();
  assert.equal(requests[0].delegationMode, true);
  assert.equal(get().current.delegationMode, true);
  assert.equal(storage.get("cx-draft-created"), "共享输入");
  assert.equal(storage.get("cx-draft-original"), "原对话输入");
  assert.equal(storage.has("cx-draft-new"), false);
  set({ current: { id: "saved-off", delegationMode: false } });
  assert.equal(get().delegationMode, false);
});

test("Antigravity 新建不显示原生委派开关，保留本轮执行端选择", async (t) => {
  const { get, set, requests, newChat, ensureThread } = navigationFixture(t);
  newChat(undefined, { backendId: "agy" });
  set({ backendId: "agy" });
  assert.equal(get().delegationMode, false);
  set({ agyDelegateTo: "claude" });
  newChat();
  assert.equal(get().agyDelegateTo, "claude");
  await ensureThread(true);
  assert.equal(Object.hasOwn(requests[0], "delegationMode"), false);
});

test("接收端不可用或特性禁用时，已有对话保留服务端记录，新建采用关闭状态", (t) => {
  const { get, set, newChat } = navigationFixture(t);
  set({
    backends: get().backends.map((backend) =>
      backend.id === "claude" ? { ...backend, ready: false } : backend,
    ),
  });
  assert.equal(get().delegationMode, true);
  newChat();
  assert.equal(get().delegationMode, false);
  set({
    current: { id: "saved-on", delegationMode: true },
    nativeDelegation: false,
  });
  assert.equal(get().delegationMode, true);
  newChat();
  assert.equal(get().delegationMode, false);
});

test("新建草稿在三端共享正文和附件，移除后切换仍保持移除", async (t) => {
  const { get, set, newChat, messages, switchBackend } = navigationFixture(t);
  newChat();
  const image = {
    id: "image",
    kind: "image",
    preview: "data:image/png;base64,AA==",
  };
  const file = { id: "file", kind: "text", path: "/demo/uploaded.txt" };
  const reference = codeLineAttachment("return total + 1", [
    { path: "/demo/source.py", line: 2 },
  ]);
  assert(reference);
  for (const entry of [image, file, reference]) messages.addAttachment(entry);
  const attachments = get().attachments;
  for (const id of ["claude", "codex", "agy"]) {
    await switchBackend(id);
    assert.equal(get().backendId, id);
    assert.equal(get().draft, "共享输入");
    assert.equal(get().attachments, attachments);
  }
  set({ attachments: [file, reference] });
  await switchBackend("codex");
  await switchBackend("agy");
  assert.deepEqual(get().attachments, [file, reference]);
});

test("已有对话各自保留附件，首轮创建后从新会话迁移原草稿", async (t) => {
  const {
    get,
    openThread,
    newChat,
    ensureThread,
    messages,
    getAttachmentDraft,
    storage,
  } = navigationFixture(t);
  const first = { id: "first", path: "/demo/first.txt" };
  const second = { id: "second", path: "/demo/second.txt" };
  const shared = { id: "shared", path: "/demo/shared.txt" };
  messages.addAttachment(first);
  newChat();
  messages.addAttachment(shared);
  const sharedDraft = getAttachmentDraft();
  await openThread("backend:claude:second");
  assert.equal(get().threadAccess.status, "ready");
  assert.deepEqual(get().attachments, []);
  messages.addAttachment(second);
  await openThread("original");
  assert.deepEqual(get().attachments, [first]);
  await openThread("backend:claude:second");
  assert.deepEqual(get().attachments, [second]);
  newChat("/demo");
  assert.deepEqual(get().attachments, [shared]);
  await ensureThread();
  assert.equal(get().current.id, "created");
  assert.equal(getAttachmentDraft(), sharedDraft);
  assert.deepEqual(get().attachments, [shared]);
  newChat();
  assert.deepEqual(get().attachments, []);
  assert.equal(get().draft, "");
  assert.equal(storage.has("cx-draft-new"), false);
  await openThread("created");
  assert.deepEqual(get().attachments, [shared]);
});

test("跨后端读取附件，首轮失败保留已上传路径，重试只清理提交快照", async (t) => {
  const allowRead = Promise.withResolvers();
  const originalReader = globalThis.FileReader;
  globalThis.FileReader = class {
    async readAsDataURL() {
      await allowRead.promise;
      this.result = "data:text/plain;base64,eA==";
      this.onload();
    }
  };
  t.after(() => (globalThis.FileReader = originalReader));
  const submitted = Promise.withResolvers();
  const acknowledge = Promise.withResolvers();
  let uploads = 0;
  let turns = 0;
  const { get, newChat, messages, switchBackend } = navigationFixture(
    t,
    async (method, params) => {
      if (method === "fs/uploadAttachment") {
        assert.deepEqual(params, { name: "draft.txt", dataBase64: "eA==" });
        uploads++;
        return { path: "/uploads/draft.txt" };
      }
      assert.equal(method, "turn/start");
      assert.equal(params.threadId, "created");
      if (++turns === 1) throw new Error("发送失败");
      submitted.resolve();
      return acknowledge.promise;
    },
  );
  newChat();
  const reading = messages.attachFile({
    name: "draft.txt",
    type: "text/plain",
    size: 1,
  });
  await switchBackend("claude");
  allowRead.resolve();
  await reading;
  const [draft] = get().attachments;
  assert.equal(draft.name, "draft.txt");
  assert.equal(await messages.sendMessage(), false);
  assert.equal(draft.path, "/uploads/draft.txt");
  assert.equal(get().draft, "共享输入");
  assert.deepEqual(get().attachments, [draft]);
  const retry = messages.sendMessage();
  await submitted.promise;
  const added = { id: "added", path: "/demo/added.txt" };
  messages.addAttachment(added);
  acknowledge.resolve({});
  assert.equal(await retry, true);
  assert.equal(uploads, 1);
  assert.equal(get().draft, "");
  assert.deepEqual(get().attachments, [added]);
});

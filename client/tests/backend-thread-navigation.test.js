import assert from "node:assert/strict";
import test from "node:test";
import { createAppState } from "../src/application/state.js";
import { createModelPreferences } from "../src/application/models.js";
import { createBackends } from "../src/application/backends.js";
import { createThreadRecords } from "../src/application/thread-records.js";
import { createThreadNavigation } from "../src/application/thread-navigation.js";
import { resourceTarget } from "../../shared/backend-identity.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness(t) {
  const original = globalThis.localStorage;
  const saved = new Map();
  globalThis.localStorage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: (key) => saved.delete(key),
  };
  t.after(() => {
    globalThis.localStorage = original;
  });
  const { get, set } = createAppState();
  const transport = { connection: {} };
  const calls = [],
    pending = [],
    errors = [];
  const records = new Map();
  let held = true;
  const release = () => {
    held = false;
    pending.splice(0).forEach((resolve) => resolve());
  };
  t.after(async () => {
    release();
    await tick();
  });
  set({
    connected: true,
    cwd: "/workspace",
    defaultCwd: "/workspace",
    backends: ["codex", "claude", "opencode"].map((id) => ({
      id,
      type: id,
      enabled: true,
    })),
    modelChoices: [],
  });
  const rpc = async (method, p = {}) => {
    calls.push({ method, ...p });
    const backendId =
      p.backendId ||
      (p.threadId && resourceTarget(p.threadId).backendId) ||
      get().backendId;
    if (method === "thread/read" || method === "thread/resume") {
      const thread = records.get(p.threadId);
      if (thread instanceof Error) throw thread;
      return {
        thread,
        model: thread.model,
        reasoningEffort: "high",
        serviceTier: "priority",
      };
    }
    if (method === "thread/items/list")
      return {
        data: [
          {
            turnId: "turn",
            item: {
              id: p.threadId + "-answer",
              type: "agentMessage",
              text: p.threadId,
            },
          },
        ],
        nextCursor: null,
      };
    if (method === "thread/turns/list") return { data: [], nextCursor: null };
    if (held) await new Promise((resolve) => pending.push(resolve));
    if (method === "model/list")
      return {
        data: [
          {
            id: backendId,
            model: backendId + "-model",
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            serviceTiers: [{ id: "priority" }],
          },
        ],
      };
    if (method === "lan/providers/list")
      return {
        providers: [{ id: "vendor", name: "Vendor", models: ["claude-model"] }],
      };
    if (method === "config/read")
      return { config: { model: backendId + "-model" } };
    if (method === "account/read")
      return { account: { name: backendId + ":" + p.providerId } };
    if (
      method === "lan/projectModels/read" ||
      method === "lan/projectModels/set"
    )
      return { projects: {} };
    throw new Error(method);
  };
  const report = (error) => errors.push(error);
  const models = createModelPreferences({ get, set, rpc, transport, report });
  const backends = createBackends({ get, set, rpc, transport, models, report });
  const navigation = createThreadNavigation({
    get,
    set,
    rpc,
    transport,
    models,
    records: createThreadRecords({ get, set, rpc }),
    getConnectionRevision: () => 0,
    activateThreadBackend: backends.activateThreadBackend,
    selectProvider: backends.selectProvider,
  });
  function thread(backendId, suffix, cwd = "/workspace") {
    const id =
      backendId === "codex" ? suffix : `backend:${backendId}:${suffix}`;
    records.set(id, {
      id,
      name: suffix,
      cwd,
      model: backendId + "-model",
      providerId: backendId === "claude" ? "vendor" : "",
      createdAt: 1,
      completedAt: 2,
    });
    return id;
  }
  return {
    get,
    set,
    calls,
    errors,
    records,
    models,
    navigation,
    thread,
    release,
    pending,
    transport,
  };
}

test("三后端对话首屏与恢复就绪均独立于尚未返回的模型、账户及配置", async (t) => {
  const h = harness(t);
  for (const backendId of ["codex", "claude", "opencode", "claude", "codex"]) {
    const id = h.thread(backendId, "target-" + h.calls.length);
    const start = h.calls.length;
    let done = false;
    const opened = h.navigation.openThread(id).then(() => {
      done = true;
    });
    await tick();
    assert.equal(done, true, `${backendId} 对话等待了辅助请求`);
    await opened;
    assert.equal(h.calls[start].method, "thread/read");
    assert.equal(h.get().backendId, backendId);
    assert.equal(h.get().current.id, id);
    assert.equal(h.get().items[0].text, id);
    assert.equal(h.get().loading, false);
    assert.equal(h.get().threadAccess.status, "ready");
    assert.equal(h.get().model, backendId + "-model");
    assert.equal(h.get().serviceTier, "priority");
  }
  assert.ok(h.pending.length > 0);
  h.release();
  await tick();
  assert.equal(h.get().backendId, "codex");
  assert.equal(h.get().model, "codex-model");
  assert.deepEqual(h.errors, []);
});

test("目录恢复期间连续切换工作区、供应商与模型保留最新选择", async (t) => {
  const h = harness(t);
  await h.navigation.openThread(h.thread("claude", "first", "/first"));
  const id = h.thread("claude", "second", "/second");
  await h.navigation.openThread(id);
  h.set({ model: "manual-model", effort: "ultra", serviceTier: "ultrafast" });
  h.release();
  await tick();
  assert.equal(h.get().current.id, id);
  assert.equal(h.get().cwd, "/second");
  assert.equal(h.get().providerId, "vendor");
  assert.equal(h.get().model, "manual-model");
  assert.equal(h.get().effort, "ultra");
  assert.equal(h.get().serviceTier, "ultrafast");
  assert.equal(h.get().models[0].model, "claude-model");
  assert.equal(h.get().account.name, "claude:vendor");
  assert.ok(
    h.calls.some((p) => p.method === "model/list" && p.cwd === "/second"),
  );
  assert.deepEqual(h.errors, []);
});

test("目标历史失败保留原后端，断线后迟到目录不覆盖当前对话", async (t) => {
  const h = harness(t);
  await h.navigation.openThread(h.thread("codex", "source"));
  const failed = h.thread("opencode", "failed");
  h.records.set(failed, new Error("历史读取失败"));
  await h.navigation.openThread(failed);
  assert.equal(h.get().backendId, "codex");
  assert.equal(h.get().threadAccess.status, "loadError");
  const target = h.thread("opencode", "target");
  await h.navigation.openThread(target);
  h.transport.connection = {};
  h.set({ connected: false });
  h.release();
  await tick();
  assert.equal(h.get().current.id, target);
  assert.equal(h.get().account, null);
  assert.equal(h.get().model, "opencode-model");
});

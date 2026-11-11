import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTokenUsageStore } from "../src/token-usage.mjs";
import { createTokenUsageReconciliation } from "../src/token-usage-reconciliation.mjs";

test("启动分页清理归档快照，只补录未归档目录中缺少的统计", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "usage-reconcile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = (name) => `backend:claude:${name}`;
  let store = createTokenUsageStore(directory);
  store.remember(id("archived"), { last: { totalTokens: 1 } });
  store.remember(id("known"), { last: { totalTokens: 2 } });
  await store.flush();
  store = createTokenUsageStore(directory);
  const seen = [];
  const entry = { backend: { id: "claude" }, adapter: { ready: true } };
  const reconciliation = createTokenUsageReconciliation({
    store,
    current: () => true,
    async call(_entry, method, params) {
      seen.push({ method, params });
      if (method === "thread/list") {
        if (params.archived)
          return params.cursor
            ? { data: [{ id: id("archived-2") }] }
            : { data: [{ id: id("archived") }], nextCursor: "archived-next" };
        return params.cursor
          ? { data: [{ id: id("unknown") }] }
          : { data: [{ id: id("known") }], nextCursor: "active-next" };
      }
      assert.equal(params.threadId, "unknown");
      assert.equal(params.includeTurns, false);
      return store.result(
        {
          thread: {
            id: id("unknown"),
            tokenUsage: { last: { totalTokens: 3 } },
          },
        },
        "thread/read",
        0,
      );
    },
  });
  reconciliation.start(entry);
  reconciliation.start(entry);
  await reconciliation.flush();
  assert.equal(
    seen.filter((request) => request.method === "thread/read").length,
    1,
  );
  const status = reconciliation.snapshot().claude;
  assert.equal(status.status, "completed");
  assert.equal(status.archived, 2);
  assert.equal(status.checked, 2);
  assert.equal(status.imported, 1);
  assert.equal(status.failed, 0);
  const restored = createTokenUsageStore(directory);
  assert.equal(await restored.read(id("archived")), null);
  assert.equal((await restored.read(id("known"))).last.totalTokens, 2);
  assert.equal((await restored.read(id("unknown"))).last.totalTokens, 3);
});

test("核对期间恢复归档并收到新统计时，迟到归档列表保留新快照", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "usage-unarchive-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createTokenUsageStore(directory);
  store.remember("same", { last: { totalTokens: 1 } });
  await store.flush();
  const reconciliation = createTokenUsageReconciliation({
    store,
    current: () => true,
    async call(_entry, _method, params) {
      if (!params.archived) return { data: [] };
      store.archive("same", false);
      store.remember("same", { last: { totalTokens: 2 } });
      return { data: [{ id: "same" }] };
    },
  });
  reconciliation.start({ backend: { id: "codex" }, adapter: { ready: true } });
  await reconciliation.flush();
  assert.equal(
    (await createTokenUsageStore(directory).read("same")).last.totalTokens,
    2,
  );
});

test("关闭时取消正在等待的启动核对请求", async () => {
  const reconciliation = createTokenUsageReconciliation({
    store: { flush: async () => {}, revisions: () => new Map() },
    current: () => true,
    call: (_entry, _method, _params, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
  });
  reconciliation.start({ backend: { id: "codex" }, adapter: { ready: true } });
  reconciliation.stop();
  await reconciliation.flush();
  assert.equal(reconciliation.snapshot().codex.status, "stopped");
  assert.equal(reconciliation.snapshot().codex.error, null);
});

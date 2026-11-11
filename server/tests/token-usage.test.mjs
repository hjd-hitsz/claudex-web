import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTokenUsageStore } from "../src/token-usage.mjs";

const usage = (totalTokens) => ({
  total: { totalTokens: totalTokens * 3 },
  last: { totalTokens, inputTokens: totalTokens - 1, outputTokens: 1 },
  modelContextWindow: 475000,
});

test("末尾分支固定来源快照并独立保存，指定轮次只继承相同轮次的统计", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "token-fork-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = createTokenUsageStore(directory);
  store.remember("parent", usage(10), "turn-1");
  await store.flush();
  store = createTokenUsageStore(directory);
  const snapshot = await store.forkSource({ threadId: "parent" });
  assert.deepEqual(
    await store.forkSource({ threadId: "parent", lastTurnId: "turn-1" }),
    snapshot,
  );
  assert.equal(
    await store.forkSource({ threadId: "parent", lastTurnId: "older" }),
    null,
  );
  assert.equal(
    await store.forkSource({ threadId: "parent", beforeTurnId: "turn-1" }),
    null,
  );
  store.remember("parent", usage(20), "turn-2");
  const result = await store.result(
    { thread: { id: "child" } },
    "thread/fork",
    0,
    snapshot,
  );
  assert.deepEqual(result.thread.tokenUsage, usage(10));
  store.remember("child", usage(30), "child-turn");
  assert.deepEqual(await store.read("parent"), usage(20));
  await store.flush();
  assert.deepEqual(
    await createTokenUsageStore(directory).read("child"),
    usage(30),
  );
  const pending = store.result(
    { thread: { id: "live-child" } },
    "thread/fork",
    0,
    snapshot,
  );
  store.remember("live-child", usage(40), "live-turn");
  assert.deepEqual((await pending).thread.tokenUsage, usage(40));
  await store.flush();
});

test("全部对话分别持久化，重启读取且并发更新保留各对话最新值", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "token-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createTokenUsageStore(directory);
  for (let index = 1; index <= 100; index++) {
    store.remember("same", usage(index));
    store.remember("backend:claude:same", usage(index + 100));
    store.remember("../路径/对话", usage(index + 200));
  }
  await store.flush();
  const restored = createTokenUsageStore(directory);
  assert.deepEqual(await restored.read("same"), usage(100));
  assert.deepEqual(await restored.read("backend:claude:same"), usage(200));
  assert.deepEqual(await restored.read("../路径/对话"), usage(300));
  const files = await readdir(join(directory, "token-usage"));
  assert.equal(files.length, 3);
  for (const file of files)
    assert.equal(
      (await stat(join(directory, "token-usage", file))).mode & 0o777,
      0o600,
    );
  assert.equal(
    (await stat(join(directory, "token-usage"))).mode & 0o777,
    0o700,
  );
});

test("恢复响应与实时通知竞态保持新统计，后端已有统计按普通读取保存", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "token-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createTokenUsageStore(directory);
  const revision = store.revision("same");
  const response = store.result(
    { thread: { id: "same", tokenUsage: usage(1) } },
    "thread/read",
    revision,
  );
  store.observe({
    method: "thread/tokenUsage/updated",
    params: { threadId: "same", tokenUsage: usage(2) },
  });
  assert.deepEqual((await response).thread.tokenUsage, usage(2));
  const restored = await store.result(
    { thread: { id: "same" } },
    "thread/resume",
    store.revision("same"),
  );
  assert.deepEqual(restored.thread.tokenUsage, usage(2));
  await store.result(
    { thread: { id: "other", tokenUsage: usage(3) } },
    "thread/read",
    0,
  );
  await store.flush();
  assert.deepEqual(
    await createTokenUsageStore(directory).read("other"),
    usage(3),
  );
  assert.equal(
    (await store.result({ thread: { id: "unknown" } }, "thread/read", 0)).thread
      .tokenUsage,
    undefined,
  );
  const pending = store.result(
    { thread: { id: "pending", tokenUsage: usage(4) } },
    "thread/read",
    0,
  );
  await store.flush();
  await pending;
  assert.deepEqual(
    await createTokenUsageStore(directory).read("pending"),
    usage(4),
  );
});

test("归档与删除清除快照，归档期间忽略统计，恢复后由新回复重新写入", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "token-archive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createTokenUsageStore(directory);
  store.remember("same", usage(1));
  store.observe({ method: "thread/archived", params: { threadId: "same" } });
  store.remember("same", usage(2));
  await store.flush();
  assert.equal(await createTokenUsageStore(directory).read("same"), null);
  store.observe({ method: "thread/unarchived", params: { threadId: "same" } });
  assert.equal(await store.read("same"), null);
  store.remember("same", usage(3));
  await store.flush();
  assert.deepEqual(
    await createTokenUsageStore(directory).read("same"),
    usage(3),
  );
  store.remove("same");
  store.remember("same", usage(4));
  store.remember("quick-restore", usage(1));
  store.archive("quick-restore");
  store.archive("quick-restore", false);
  await store.flush();
  assert.deepEqual(await readdir(join(directory, "token-usage")), []);
});

test("写入失败保留内存统计并可重试，损坏快照由新的用量替换", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "token-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  const path = join(directory, "token-usage");
  await writeFile(path, "fixture blocks directory creation");
  const store = createTokenUsageStore(directory);
  store.remember("same", usage(1));
  await assert.rejects(store.flush());
  assert.deepEqual(await store.read("same"), usage(1));
  await rm(path);
  store.remember("same", usage(1));
  await store.flush();
  const [file] = await readdir(path);
  await writeFile(join(path, file), "{");
  const restored = createTokenUsageStore(directory);
  await assert.rejects(restored.read("same"));
  restored.remember("same", usage(2));
  await restored.flush();
  assert.deepEqual(
    await createTokenUsageStore(directory).read("same"),
    usage(2),
  );
});

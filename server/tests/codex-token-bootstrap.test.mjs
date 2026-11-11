import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { zstdCompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexTokenUsage } from "../src/backends/codex/token-usage.mjs";
import { createTokenUsageStore } from "../src/token-usage.mjs";
import { createBridgeEvents } from "../src/backends/codex/events.mjs";

const line = (record) => JSON.stringify(record) + "\n";
const usage = (totalTokens) => ({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { total_tokens: totalTokens * 10 },
      last_token_usage: {
        total_tokens: totalTokens,
        input_tokens: totalTokens - 1,
        output_tokens: 1,
      },
      model_context_window: 475000,
    },
  },
});

test("启动核对的内部读取保持只读，普通打开继续使用既有标题流程", () => {
  let scheduled = 0,
    sent = 0;
  const events = createBridgeEvents({
    terminals: new Map(),
    send: () => sent++,
    releaseUnusedThreads() {},
    threadNaming: { schedule: () => scheduled++ },
  });
  for (const readOnly of [true, false])
    events.onResponse(
      { id: 1, method: "thread/read", client: { readOnly } },
      { result: { thread: { id: "fixture" } } },
    );
  assert.equal(sent, 2);
  assert.equal(scheduled, 1);
});

test("分页分支按原生 history_base 边界补录，来源后续统计保持隔离", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bootstrap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parent = { id: "parent", path: join(directory, "parent.jsonl") };
  const child = { id: "child", path: join(directory, "child.jsonl") };
  const prefix =
    line({ type: "session_meta", payload: { id: parent.id } }) +
    line(usage(49658));
  await writeFile(parent.path, prefix + line(usage(118863)) + '{"type":');
  await writeFile(
    child.path,
    line({
      type: "session_meta",
      payload: {
        id: child.id,
        history_base: {
          thread_id: parent.id,
          end_byte_offset: Buffer.byteLength(prefix),
        },
      },
    }),
  );
  let calls = 0;
  const native = async (method, params) => {
    calls++;
    assert.equal(method, "thread/read");
    assert.equal(params.includeTurns, false);
    assert.equal(params.threadId, parent.id);
    return { thread: parent };
  };
  assert.equal(
    (await readCodexTokenUsage(parent, native)).tokenUsage.last.totalTokens,
    118863,
  );
  const store = createTokenUsageStore(directory);
  const result = await store.result(
    { thread: child },
    "thread/fork",
    0,
    { tokenUsage: { last: { totalTokens: 118863 } } },
    (thread) => readCodexTokenUsage(thread, native),
  );
  assert.equal(result.thread.tokenUsage.last.totalTokens, 49658);
  await store.flush();
  const restored = createTokenUsageStore(directory);
  await restored.result({ thread: child }, "thread/read", 0, null, () => {
    throw Error("已有快照应直接读取");
  });
  assert.equal(calls, 1);
  assert.equal((await restored.read(child.id)).last.totalTokens, 49658);
  await writeFile(
    parent.path + ".zst",
    zstdCompressSync(await readFile(parent.path)),
  );
  await rm(parent.path);
  assert.equal(
    (await readCodexTokenUsage(parent, native)).tokenUsage.last.totalTokens,
    118863,
  );
  assert.equal(
    (await readCodexTokenUsage(child, native)).tokenUsage.last.totalTokens,
    49658,
  );
  assert.equal(
    (
      await readCodexTokenUsage(
        { ...parent, path: parent.path + ".zst" },
        native,
      )
    ).tokenUsage.last.totalTokens,
    118863,
  );
});

test("首次补录合并并发读取，实时统计和归档优先于迟到补录", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bootstrap-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createTokenUsageStore(directory);
  let resolve,
    calls = 0;
  const loader = () => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  };
  const first = store.result(
    { thread: { id: "same" } },
    "thread/read",
    0,
    null,
    loader,
  );
  const second = store.result(
    { thread: { id: "same" } },
    "thread/resume",
    0,
    null,
    loader,
  );
  while (!resolve) await new Promise((done) => setImmediate(done));
  store.remember("same", { last: { totalTokens: 200 } });
  resolve({ tokenUsage: { last: { totalTokens: 100 } } });
  for (const result of await Promise.all([first, second]))
    assert.equal(result.thread.tokenUsage.last.totalTokens, 200);
  assert.equal(calls, 1);
  store.archive("archived");
  await store.result(
    { thread: { id: "archived" } },
    "thread/read",
    0,
    null,
    () => {
      throw Error("归档应跳过补录");
    },
  );
  await store.flush();
});

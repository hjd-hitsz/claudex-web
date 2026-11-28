import test from "node:test";
import assert from "node:assert/strict";
import {
  createTokenUsage,
  configuredTokenUsage,
} from "../src/backends/claude/token-usage.mjs";
import { providerRuntimeEnvironment } from "../src/backends/claude/provider-environment.mjs";
import { historyTurns } from "../src/backends/claude/messages.mjs";

test("历史读取采用所属供应商模型的实际配置容量，原生账户保持原生快照", () => {
  const session = {
    model: "custom",
    tokenUsage: { last: { totalTokens: 43938 }, modelContextWindow: 200000 },
  };
  const provider = {
    modelCapabilities: {
      custom: { contextWindow: 196608 },
      other: { contextWindow: 32768 },
    },
  };
  assert.equal(
    configuredTokenUsage(session, provider).modelContextWindow,
    196608,
  );
  assert.equal(
    configuredTokenUsage({ ...session, model: "other" }, provider)
      .modelContextWindow,
    32768,
  );
  assert.equal(configuredTokenUsage(session, null).modelContextWindow, 200000);
  assert.equal(configuredTokenUsage(session, provider).last.totalTokens, 43938);
  assert.equal(session.tokenUsage.modelContextWindow, 200000);
});

test("首次原生assistant用量即展示当前模型容量，恢复和模型切换重新查询", async () => {
  let session = {
    model: "old",
    tokenUsage: { modelContextWindow: 200000 },
  };
  const events = [];
  const usage = createTokenUsage({
    threadId: "thread",
    session,
    save: async (_id, update) => {
      session = update(session);
    },
    emit: (_method, event) => events.push(event),
  });
  let capacity = 196608,
    calls = 0;
  const process = {
    model: "custom",
    query: {
      getContextUsage: async (params) => {
        assert.deepEqual(params, { detail: "summary" });
        calls++;
        return { rawMaxTokens: capacity, totalTokens: 45000 };
      },
    },
  };
  const message = {
    type: "assistant",
    message: { usage: { input_tokens: 43938 } },
  };
  await usage(
    {
      type: "stream_event",
      event: { type: "message_start", message: message.message },
    },
    process,
  );
  assert.equal(session.tokenUsage.modelContextWindow, 196608);
  assert.equal(session.tokenUsage.last.totalTokens, 43938);
  await usage(message, process);
  assert.equal(calls, 1);
  process.model = "different";
  capacity = 32768;
  await usage(message, process);
  assert.equal(session.tokenUsage.modelContextWindow, 32768);
  assert.equal(calls, 2);
  await usage(
    { type: "result", modelUsage: { different: { contextWindow: 32768 } } },
    process,
  );
  assert.equal(session.tokenUsage.last.totalTokens, 45000);
  assert.equal(events.at(-1).tokenUsage.modelContextWindow, 32768);
});

test("原生容量读取失败清除旧模型容量，保留实际用量与读取错误", async () => {
  let session = { tokenUsage: { modelContextWindow: 200000 } };
  const usage = createTokenUsage({
    threadId: "thread",
    session,
    save: async (_id, update) => {
      session = update(session);
    },
    emit() {},
  });
  await usage(
    { type: "assistant", message: { usage: { input_tokens: 20 } } },
    {
      model: "custom",
      query: {
        getContextUsage: async () => {
          throw Error("context unavailable");
        },
      },
    },
  );
  assert.equal(session.tokenUsage.modelContextWindow, undefined);
  assert.equal(session.tokenUsage.last.totalTokens, 20);
  assert.equal(session.tokenUsage.error, "context unavailable");
});

test("模型实际容量配置传给原生CLI，其他模型清除覆盖而原生账户保留环境", () => {
  const provider = {
    models: ["custom"],
    modelCapabilities: { custom: { contextWindow: 196608 } },
  };
  assert.equal(
    providerRuntimeEnvironment(provider, { dataDir: "/isolated" })
      .CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    "196608",
  );
  assert.equal(
    providerRuntimeEnvironment(
      provider,
      { dataDir: "/isolated" },
      { model: "other" },
    ).CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    "",
  );
  assert.equal(
    providerRuntimeEnvironment(null, { dataDir: "/isolated" })
      .CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
  );
});

test("合并原生流事件的累计计数，并按本轮收到的结果累计主循环用量", async () => {
  const events = [];
  const usage = createTokenUsage({
    threadId: "thread",
    session: {},
    save: async () => {},
    emit: (_method, { tokenUsage }) => events.push(tokenUsage),
  });
  const process = {
    model: "deepseek-v4.1-flash",
    query: {
      getContextUsage: async () => ({
        rawMaxTokens: 200000,
        totalTokens: 1250,
      }),
    },
  };
  const turn = { id: "turn" };
  const send = (message) => usage(message, process, turn);
  const initial = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const first = { ...initial, input_tokens: 1065, output_tokens: 58 };
  const second = {
    ...initial,
    input_tokens: 119,
    output_tokens: 88,
    cache_read_input_tokens: 1024,
  };
  // OpenCode Go emits message_delta.usage without an ID. The preceding
  // message_start supplies the ID, and assistant blocks carry start counts.
  const start = (id) =>
    send({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_start", message: { id, usage: initial } },
    });
  const delta = (usage, stop_reason) =>
    send({
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "message_delta",
        usage,
        delta: { stop_reason, stop_sequence: null },
      },
    });
  const assistant = (id) =>
    send({ type: "assistant", message: { id, usage: initial } });
  await start("first");
  await assistant("first");
  await delta(first, "tool_use");
  await assistant("first");
  await delta(first, "tool_use");
  assert.deepEqual(
    events.map(({ last }) => last.totalTokens),
    [1123],
  );
  await start("second");
  await assistant("first");
  await delta(second, "end_turn");
  assert.deepEqual(
    events.map(({ last }) => last.totalTokens),
    [1123, 1231],
  );
  await send({
    type: "result",
    usage: {
      ...initial,
      input_tokens: 1184,
      output_tokens: 146,
      cache_read_input_tokens: 1024,
    },
  });
  assert.equal(turn.tokenUsage.last.totalTokens, 1250);
  assert.deepEqual(turn.tokenUsage.round, {
    inputTokens: 1184,
    outputTokens: 146,
    cachedInputTokens: 1024,
    totalTokens: 2354,
  });
  await send({ type: "result", usage: first });
  assert.deepEqual(turn.tokenUsage.round, {
    inputTokens: 2249,
    outputTokens: 204,
    cachedInputTokens: 1024,
    totalTokens: 3477,
  });
  const next = { id: "next" };
  await usage({ type: "result", usage: first }, process, next);
  assert.equal(next.tokenUsage.round.totalTokens, 1123);
});

test("原生历史按主会话模型消息 ID 去重并保留各轮已记录的字段", () => {
  const input = (uuid) => ({
    type: "user",
    uuid,
    message: { content: [{ type: "text", text: "读取文件" }] },
  });
  const assistant = (id, usage, extra = {}) => ({
    type: "assistant",
    message: { id, usage, content: [] },
    ...extra,
  });
  const [first, second, third] = historyTurns([
    input("first"),
    assistant("first-model", { input_tokens: 1007, output_tokens: 0 }),
    assistant("first-model", { input_tokens: 1007, output_tokens: 57 }),
    assistant("first-model", { input_tokens: 1007, output_tokens: 0 }),
    assistant("side", { output_tokens: 999 }, { isSidechain: true }),
    assistant("second-model", {
      input_tokens: 189,
      output_tokens: 145,
      cache_read_input_tokens: 896,
    }),
    input("second"),
    assistant("second-model", { output_tokens: 145 }),
    assistant("third-model", { output_tokens: 18 }),
    input("third"),
  ]);
  assert.deepEqual(first.tokenUsage.round, {
    inputTokens: 1196,
    outputTokens: 202,
    cachedInputTokens: 896,
    totalTokens: 2294,
  });
  assert.deepEqual(second.tokenUsage.round, {
    outputTokens: 18,
    totalTokens: 18,
  });
  assert.equal(third.tokenUsage, undefined);
});

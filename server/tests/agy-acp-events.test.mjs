import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAcpUpdate,
  flushAcpMessage,
} from "../src/backends/agy/acp-events.mjs";
import { visibleAgyItems } from "../src/backends/agy/acp-messages.mjs";

const settingsNotice =
  "<USER_SETTINGS_CHANGE> The user changed setting \u0060Model Selection\u0060 from None to Gemini 3.8 Flash (High). </USER_SETTINGS_CHANGE>";

test("Antigravity 流式设置通知跨分片且紧跟工具调用时，正文仍可继续输出", () => {
  const activity = { turn: { id: "turn", items: [] }, session: { cwd: "/" } };
  const events = [];
  const emit = (method, params) => events.push({ method, params });
  const text = (text) =>
    applyAcpUpdate(
      activity,
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
      emit,
    );
  const first = settingsNotice.slice(0, 12);
  text(first);
  text(settingsNotice.slice(first.length, -3));
  assert.deepEqual(events, []);
  text(settingsNotice.slice(-3));
  assert.deepEqual(events, []);
  applyAcpUpdate(
    activity,
    { sessionUpdate: "tool_call", toolCallId: "tool" },
    emit,
  );
  text(settingsNotice + "\n已完成核对。");
  text("可见正文保留。");
  assert.equal(activity.turn.items.at(-1).text, "已完成核对。可见正文保留。");
  assert(!JSON.stringify(events).includes("USER_SETTINGS_CHANGE"));
});

test("历史投影清理原生设置通知并保留用户引用和普通回复", () => {
  const user = {
    type: "userMessage",
    content: [{ type: "text", text: settingsNotice }],
  };
  const excerpt = {
    type: "agentMessage",
    text: "`<USER_SETTINGS_CHANGE>` 是什么？",
  };
  const truncated = { type: "agentMessage", text: "<USER_SE" };
  assert.deepEqual(
    visibleAgyItems([
      user,
      { type: "agentMessage", text: settingsNotice },
      { type: "agentMessage", text: settingsNotice + "\n这是正文。" },
      excerpt,
      truncated,
    ]),
    [user, { type: "agentMessage", text: "这是正文。" }, excerpt, truncated],
  );
  const activity = { turn: { id: "turn", items: [] } };
  applyAcpUpdate(
    activity,
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: truncated.text },
    },
    () => {},
  );
  flushAcpMessage(activity, () => {});
  assert.equal(activity.turn.items[0].text, truncated.text);
});

test("原生非零退出码呈现实际输出，空文本条目使用工具失败提示", () => {
  const activity = { turn: { id: "turn", items: [] }, session: { cwd: "/" } };
  const empty = [{ type: "content", content: { type: "text", text: "" } }];
  const update = (id, status, rawOutput) =>
    applyAcpUpdate(
      activity,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        title: "ls fixture-missing",
        kind: "execute",
        status,
        rawOutput,
        content: empty,
      },
      () => {},
    );
  update("native", "completed", {
    output: "Command exited with code 2.\nfixture-missing",
    exit_code: 2,
  });
  const [native] = activity.turn.items;
  assert.equal(native.status, "failed");
  assert.equal(native.error, "命令退出码 2");
  assert.match(native.result.content[0].text, /fixture-missing/);
  update("empty", "failed", { output: "" });
  assert.equal(activity.turn.items[1].result, undefined);
});

test("ACP 相邻摘要共用记录，新工具或新文件变更开始下一组", () => {
  const turn = { id: "turn", items: [] };
  const activity = { turn, session: { cwd: process.cwd() } };
  const events = [];
  const update = (sessionUpdate, params) =>
    applyAcpUpdate(activity, { sessionUpdate, ...params }, (method, data) =>
      events.push({ method, ...structuredClone(data) }),
    );
  const thought = (text) =>
    update("agent_thought_chunk", { content: { type: "text", text } });
  const tool = (kind, params = {}) =>
    update(kind, { toolCallId: "tool", ...params });
  const diff = {
    status: "completed",
    content: [
      { type: "diff", path: "example.txt", oldText: null, newText: "示例" },
    ],
  };

  thought("第一段");
  thought("\n\n第二段");
  tool("tool_call", { status: "pending" });
  thought("读取之后");
  tool("tool_call_update", { status: "in_progress" });
  thought("继续第二组");
  tool("tool_call_update", diff);
  thought("变更之后");
  tool("tool_call_update", diff);
  thought("继续第三组");

  assert.deepEqual(
    turn.items.map(({ type, summary }) => summary ?? type),
    [
      ["第一段\n\n第二段"],
      "mcpToolCall",
      ["读取之后继续第二组"],
      "fileChange",
      ["变更之后继续第三组"],
    ],
  );
  const started = events.filter(({ method }) => method === "item/started");
  assert.deepEqual(
    started.map(({ item }) => [item.id, item.expandableSummary]),
    turn.items
      .filter(({ type }) => type === "reasoning")
      .map(({ id }) => [id, true]),
  );
  assert.deepEqual(
    events
      .filter(({ method }) => method === "item/reasoning/summaryTextDelta")
      .map(({ itemId, summaryIndex }) => [itemId, summaryIndex]),
    started.flatMap(({ item }) => [
      [item.id, 0],
      [item.id, 0],
    ]),
  );
});

test("ACP 工具的首条通知为状态更新时也分隔摘要", () => {
  const turn = { id: "turn", items: [] };
  const activity = { turn, session: { cwd: process.cwd() } };
  for (const update of [
    { sessionUpdate: "agent_thought_chunk", content: { text: "第一组" } },
    { sessionUpdate: "tool_call_update", toolCallId: "tool" },
    { sessionUpdate: "agent_thought_chunk", content: { text: "第二组" } },
  ])
    applyAcpUpdate(activity, update, () => {});
  assert.deepEqual(
    turn.items.map(({ type }) => type),
    ["reasoning", "mcpToolCall", "reasoning"],
  );
});

test("旧 Antigravity 历史摘要沿用原记录并支持展开长正文", () => {
  const item = {
    type: "reasoning",
    id: "legacy",
    summary: ["核对图表和回退结果。".repeat(12)],
  };
  assert.deepEqual(visibleAgyItems([item]), [
    { ...item, expandableSummary: true },
  ]);
  assert.equal(item.expandableSummary, undefined);
});

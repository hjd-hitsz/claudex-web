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

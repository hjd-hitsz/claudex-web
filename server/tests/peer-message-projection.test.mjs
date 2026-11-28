import assert from "node:assert/strict";
import test from "node:test";
import { convertMessage } from "../src/backends/claude/messages.mjs";
import { claudeConversationServerName } from "../src/conversation-manager/tools.mjs";
import { codexConversationMcpName } from "../src/backends/codex/conversation-tools.mjs";
import { projectCodexDeliveryItem } from "../src/backends/codex/delivery-projection.mjs";
import {
  formatConversationMessage,
  formatLegacyConversationMessage,
  matchesConversationMessage,
} from "../src/conversation-manager/message.mjs";

const envelope = {
  id: "2847b3fe-0000-4000-8000-000000000001",
  from: { threadId: "other-session", runtimeId: "codex", title: "发布验证" },
  body: "  第一段。\n\nMessage body:\n**第二段。**\n",
};
const replyTo = "2847b3fe-0000-4000-8000-000000000002";
const codexText = (message) =>
  formatConversationMessage(message, codexConversationMcpName);
const nativeOutput = (output, source = {}) => ({
  id: "native-output",
  turnId: "native-turn",
  type: "functionCallOutput",
  namespace: codexConversationMcpName,
  name: "thread_chat_message",
  output,
  ...source,
});

test("Codex projects current and legacy peer requests and replies with the original body and trace ID", () => {
  for (const message of [envelope, { ...envelope, replyTo }]) {
    for (const format of [codexText, formatLegacyConversationMessage]) {
      const item = nativeOutput(format(message));
      assert.deepEqual(projectCodexDeliveryItem(item), {
        ...item,
        type: "peerMessage",
        messageId: message.id,
        from: message.from,
        replyTo: message.replyTo,
        body: message.body,
      });
      assert.equal(matchesConversationMessage(item.output, message), true);
      assert.equal(
        matchesConversationMessage(item.output, {
          ...message,
          body: "不同的正文",
        }),
        false,
      );
    }
  }
});

test("Codex leaves foreign tools and malformed peer headers and body boundaries untouched", () => {
  const text = codexText(envelope);
  for (const item of [
    nativeOutput(text, { namespace: "another_server" }),
    nativeOutput(text, { namespace: undefined }),
    nativeOutput(text, { name: "thread_chat" }),
    nativeOutput(text, { type: "mcpToolCall" }),
    nativeOutput(text, { output: [{ type: "text", text }] }),
    nativeOutput(text.replace(envelope.id, "invalid")),
    nativeOutput(text.replace("Peer conversation: {", "Peer conversation: [")),
    nativeOutput(text.replace('"threadId":"other-session",', "")),
    nativeOutput(text.replace('"runtimeId":"codex"', '"runtimeId":0')),
    nativeOutput(text.replace("Peer request.", "Peer reply.")),
    nativeOutput(text.replace("\nMessage body:\n", "\nMessage text:\n")),
    nativeOutput(codexText({ ...envelope, body: "\n " })),
    nativeOutput(codexText({ ...envelope, replyTo: "invalid" })),
  ])
    assert.equal(projectCodexDeliveryItem(item), item);
});

test("Claude projects a peer input without a title and preserves other native user and tool records", () => {
  const { threadId } = envelope.from;
  const message = {
    ...envelope,
    from: { threadId },
    replyTo,
  };
  const text = formatConversationMessage(message, claudeConversationServerName);
  const content = [{ type: "text", text }];
  const native = {
    type: "user",
    uuid: message.id,
    origin: { kind: "peer", from: threadId },
    message: { content },
  };
  const [item] = convertMessage(native, "turn");
  assert.equal(item.type, "peerMessage");
  assert.equal(item.messageId, message.id);
  assert.equal(item.from.title, undefined);
  assert.equal(item.replyTo, replyTo);
  assert.equal(item.body, message.body);
  assert.deepEqual(item.content, content);
  const forked = { ...native, uuid: replyTo, peerMessageId: native.uuid };
  assert.equal(convertMessage(forked, "turn")[0].id, forked.uuid);
  assert.equal(convertMessage(forked, "turn")[0].type, "peerMessage");

  for (const source of [
    { ...native, origin: undefined },
    { ...native, origin: { kind: "peer" } },
    { ...native, origin: { kind: "peer", from: "other" } },
    { ...native, uuid: replyTo },
    {
      ...native,
      message: { content: [...content, { type: "text", text: "补充文本" }] },
    },
  ])
    assert.equal(convertMessage(source, "turn")[0].type, "userMessage");

  const [tool] = convertMessage(
    {
      ...native,
      message: {
        content: [{ type: "tool_result", tool_use_id: "call", content: text }],
      },
    },
    "turn",
    new Map([["call", { id: "call", type: "dynamicToolCall" }]]),
  );
  assert.equal(tool.type, "dynamicToolCall");
  assert.equal(tool.result, text);
});

test("delegation results remain distinct from peer messages", () => {
  const result = formatConversationMessage({
    id: envelope.id,
    displayId: envelope.id.slice(0, 8),
    from: { title: "Codex" },
    delegation: true,
    body: JSON.stringify({
      stepId: envelope.id.slice(0, 8),
      task_id: replyTo,
      status: "completed",
      preview: "委派已完成",
    }),
  });
  assert.equal(
    projectCodexDeliveryItem(nativeOutput(result)).type,
    "delegationResult",
  );
  const [item] = convertMessage(
    {
      type: "user",
      uuid: envelope.id,
      origin: { kind: "peer", from: "delegate" },
      message: { content: [{ type: "text", text: result }] },
    },
    "turn",
  );
  assert.equal(item.type, "delegationResult");
  assert.equal(item.preview, "委派已完成");
});

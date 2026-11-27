import { createInterface } from "node:readline";
import { callConversationGateway } from "../../conversation-manager/gateway-client.mjs";
import { conversationCollaborationInstructions } from "../../conversation-manager/instructions.mjs";
import { conversationTools } from "../../conversation-manager/tools.mjs";
import { codexConversationMcpName } from "./conversation-tools.mjs";

const endpoint = JSON.parse(process.env.CLAUDEX_CONVERSATION_ENDPOINT);

function reply(id, payload) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n",
  );
}

async function invoke({ name, arguments: args, _meta: metadata }) {
  if (!conversationTools.some((tool) => tool.name === name))
    throw new Error("未知会话工具。");
  // Codex app-server sets _meta.threadId independently from the model arguments.
  if (typeof metadata?.threadId !== "string" || !metadata.threadId)
    throw new Error("会话工具需要所属 Codex 对话。");
  return callConversationGateway(endpoint, {
    threadId: metadata.threadId,
    turnId: metadata["x-codex-turn-metadata"]?.turn_id,
    callId: metadata.callId,
    name,
    args: args ?? {},
  });
}

async function handle({ id, method, params = {} }) {
  if (id === undefined) return;
  switch (method) {
    case "initialize":
      reply(id, {
        result: {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: codexConversationMcpName, version: "1" },
          instructions: conversationCollaborationInstructions(
            codexConversationMcpName,
          ),
        },
      });
      return;
    case "ping":
      reply(id, { result: {} });
      return;
    case "tools/list":
      reply(id, { result: { tools: conversationTools } });
      return;
    case "tools/call":
      try {
        const result = await invoke(params);
        reply(id, {
          result: { content: [{ type: "text", text: JSON.stringify(result) }] },
        });
      } catch (error) {
        reply(id, {
          result: {
            isError: true,
            content: [{ type: "text", text: error.message }],
          },
        });
      }
      return;
    default:
      reply(id, { error: { code: -32601, message: "不支持此 MCP 方法" } });
  }
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    reply(null, { error: { code: -32700, message: "无效的 JSON" } });
    return;
  }
  handle(message).catch((error) => {
    reply(message?.id ?? null, {
      error: { code: -32602, message: error.message },
    });
  });
});

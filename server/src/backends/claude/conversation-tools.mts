import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { conversationCollaborationInstructions } from "../../conversation-manager/instructions.mjs";
import { conversationTools } from "../../conversation-manager/tools.mjs";
import type { ConversationTool } from "./conversation-protocol.d.mts";

export const claudeConversationServerName = "claudex_conversation";
const schemas = conversationTools.map((definition) => ({
  ...definition,
  schema: (
    z.fromJSONSchema(
      definition.inputSchema as unknown as Parameters<
        typeof z.fromJSONSchema
      >[0],
    ) as z.ZodObject
  ).shape,
}));

export function claudeConversationTools(
  threadId: string,
  call: ConversationTool,
) {
  const tools = schemas.map((definition) =>
    tool(
      definition.name,
      definition.description,
      definition.schema,
      async (args) => {
        try {
          const outcome = await call({ threadId }, definition.name, args);
          return { content: [{ type: "text", text: JSON.stringify(outcome) }] };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
    ),
  );
  return {
    [claudeConversationServerName]: createSdkMcpServer({
      name: claudeConversationServerName,
      instructions: conversationCollaborationInstructions(
        claudeConversationServerName,
      ),
      tools,
    }),
  };
}

export function conversationToolGuard(): HookCallbackMatcher {
  return {
    matcher: `^mcp__${claudeConversationServerName}__(list_active_threads|thread_chat)$`,
    onFailure: "block",
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "PreToolUse" || !input.agent_id)
          return {};
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "会话工具使用主会话身份，请由主会话调用。",
          },
        };
      },
    ],
  };
}

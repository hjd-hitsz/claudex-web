import { readPromptSections } from "../../prompts.mjs";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  HookCallbackMatcher,
  Options,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { conversationCollaborationInstructions } from "../../conversation-manager/instructions.mjs";
import {
  claudeConversationServerName,
  conversationTools,
  delegationToolName,
  delegationStepToolName,
} from "../../conversation-manager/tools.mjs";
import type { ConversationTool } from "./conversation-protocol.d.mts";
import type { ActiveExecution } from "./execution-types.d.mts";

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
const secretaryAgent = "claudex-secretary";

function claudeConversationTools(
  threadId: string,
  call: ConversationTool,
  current: () => ActiveExecution | null | undefined,
  acceptDelegation: boolean,
) {
  const tools = schemas
    .filter(({ name }) => acceptDelegation || name !== delegationToolName)
    .map((definition) =>
      tool(
        definition.name,
        definition.description,
        definition.schema,
        async (args) => {
          try {
            const delegating = definition.name === delegationToolName;
            const active = delegating ? current() : undefined;
            if (delegating && !active)
              throw new Error("委派请求须来自当前执行中的轮次");
            const outcome = await call(
              { threadId, ...(active && { turnId: active.turn.id }) },
              definition.name,
              args,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(outcome) }],
            };
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
        {
          alwaysLoad: [delegationToolName, delegationStepToolName].includes(
            definition.name,
          ),
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

export function claudeConversationOptions(
  threadId: string,
  current: () => ActiveExecution | null | undefined,
  call: ConversationTool | undefined,
  role: string | undefined,
): Pick<Options, "agent" | "agents" | "systemPrompt" | "mcpServers"> {
  if (role && !call) throw new Error("Claude 委派工具服务尚未连接。");
  return {
    systemPrompt: { type: "preset", preset: "claude_code", snapshot: false },
    ...(role && {
      agent: secretaryAgent,
      agents: {
        [secretaryAgent]: { description: secretaryAgent, prompt: role },
      },
    }),
    ...(call && {
      mcpServers: claudeConversationTools(
        threadId,
        call,
        current,
        Boolean(role),
      ),
    }),
  };
}

export async function confirmClaudeDelegationTool(query: Query) {
  const servers = await query.mcpServerStatus();
  const server = servers.find(
    ({ name, source }) =>
      name === claudeConversationServerName && source === "sdk",
  );
  if (
    server?.status !== "connected" ||
    !server.tools?.some(({ name }) => name === delegationToolName)
  )
    throw new Error("Claude 原生会话尚未加载派单工具。");
}

export function conversationToolGuard(): HookCallbackMatcher {
  return {
    matcher: `^mcp__${claudeConversationServerName}__(list_active_threads|thread_chat|${delegationToolName}|${delegationStepToolName})$`,
    onFailure: "block",
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "PreToolUse" || !input.agent_id)
          return {};
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: readPromptSections(
              "conversation/collaboration.md",
            )("subagentToolGuard"),
          },
        };
      },
    ],
  };
}

import { readPromptSections } from "../../prompts.mjs";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { conversationCollaborationInstructions } from "../../conversation-manager/instructions.mjs";
import {
  claudeConversationServerName,
  conversationTools,
  delegationToolName,
  delegationStepToolName,
  claudeDelegationToolName,
} from "../../conversation-manager/tools.mjs";
import type { ConversationTool } from "./conversation-protocol.d.mts";
import type { ActiveExecution } from "./execution-types.d.mts";

export function claudeDispatchGuard(
  current: () => ActiveExecution | null | undefined,
): HookCallbackMatcher {
  return {
    onFailure: "block",
    hooks: [
      async (input) => {
        if (
          input.hook_event_name !== "PreToolUse" ||
          !current()?.queued.delegationContext ||
          input.tool_name === claudeDelegationToolName
        )
          return {};
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: readPromptSections(
              "delegation/workflow.md",
            )("claudeDispatchGuard"),
          },
        };
      },
    ],
  };
}

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
  current: () => ActiveExecution | null | undefined,
) {
  const tools = schemas.map((definition) =>
    tool(
      definition.name,
      definition.description,
      definition.schema,
      async (args) => {
        try {
          const active = current();
          const outcome = await call({ threadId }, definition.name, args);
          if (
            definition.name === delegationToolName &&
            active?.queued.delegationContext
          )
            active.delegationAccepted = true;
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

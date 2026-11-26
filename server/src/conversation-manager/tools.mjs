import { readPromptSections } from "../prompts.mjs";

const descriptions = readPromptSections("conversation/collaboration.md");

const text = { type: "string", minLength: 1 };
const limit = { type: "integer", minimum: 1, maximum: 50 };

export const delegationToolName = "delegate_task";
export const claudeConversationServerName = "claudex_conversation";
export const claudeDelegationToolName = `mcp__${claudeConversationServerName}__${delegationToolName}`;

const workflow = readPromptSections("delegation/workflow.md");

export const delegationStepToolName = "read_delegation_step";
export const delegationStepTool = {
  name: delegationStepToolName,
  description: workflow("readStep"),
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "stepId"],
    properties: {
      taskId: text,
      stepId: text,
      callId: text,
      turnId: text,
      offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    },
  },
};

export const conversationTools = [
  delegationStepTool,
  {
    name: delegationToolName,
    description: descriptions("delegateTask"),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["token", "request", "request_id"],
      properties: {
        token: text,
        request: { ...text, maxLength: 100000 },
        request_id: { ...text, maxLength: 128 },
        task_id: text,
        scope: { enum: ["research", "implementation"] },
      },
    },
  },
  {
    name: "list_active_threads",
    description: descriptions("listActiveThreads"),
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          enum: ["workspace", "global"],
          description: descriptions("discoveryScope"),
        },
        title: { ...text, description: descriptions("discoveryTitle") },
        cwd: {
          ...text,
          description: descriptions("discoveryCwd"),
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "thread_chat",
    description: descriptions("threadChat"),
    inputSchema: {
      type: "object",
      properties: {
        action: { enum: ["send", "reply", "status", "inbox"] },
        threadId: {
          ...text,
          description: descriptions("destinationThreadId"),
        },
        replyTo: {
          ...text,
          description: descriptions("replyTo"),
        },
        body: {
          ...text,
          maxLength: 65536,
          description: descriptions("body"),
        },
        requestId: {
          ...text,
          maxLength: 160,
          description: descriptions("requestId"),
        },
        messageId: {
          ...text,
          description: descriptions("messageId"),
        },
        cursor: text,
        limit,
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

export function conversationArguments(name, args = {}) {
  const tool = conversationTools.find((entry) => entry.name === name);
  if (!tool) throw new Error("未知会话工具");
  const { properties, required = [] } = tool.inputSchema;
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("会话工具参数须为对象");
  for (const field of required)
    if (!Object.hasOwn(args, field))
      throw new Error(`缺少会话工具参数 ${field}`);
  for (const [field, value] of Object.entries(args)) {
    const spec = Object.hasOwn(properties, field) && properties[field];
    if (
      !spec ||
      (spec.enum && !spec.enum.includes(value)) ||
      (spec.type === "string" &&
        (typeof value !== "string" ||
          value.trim().length < spec.minLength ||
          value.length > (spec.maxLength ?? 4096))) ||
      (spec.type === "integer" &&
        (!Number.isInteger(value) ||
          value < spec.minimum ||
          value > spec.maximum))
    )
      throw new Error(`会话工具参数 ${field} 无效`);
  }
  return args;
}

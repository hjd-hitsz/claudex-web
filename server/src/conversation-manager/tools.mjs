const text = { type: "string", minLength: 1 };
const limit = { type: "integer", minimum: 1, maximum: 50 };

export const conversationTools = [
  {
    name: "list_active_threads",
    description:
      'Find active conversations for a handoff, shared resource, overlapping work, or a question a peer can answer. Workspace scope is the default. Use global only when the task genuinely requires another workspace in this backend instance. Pass the selected returned threadId as the destination threadId of thread_chat with action "send".',
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          enum: ["workspace", "global"],
          description: "Defaults to the caller's actual workspace.",
        },
        title: { ...text, description: "Filter by conversation title." },
        cwd: {
          ...text,
          description:
            "Filter observed working directories in global scope. Workspace discovery follows the caller's actual workspace.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "thread_chat",
    description:
      "Coordinate asynchronously with an existing conversation. For send, use the threadId returned by list_active_threads as the destination. For reply, use the received messageId as replyTo. Claudex immediately pushes replies back to the original asking conversation and starts a new turn there if its previous turn has ended. Choose a unique requestId for each new send or reply, and reuse it on an identical retry. Claudex returns the saved messageId. Use status to troubleshoot delivery and inbox to recover incoming messages. Pass nextCursor as cursor to recover older messages.",
    inputSchema: {
      type: "object",
      properties: {
        action: { enum: ["send", "reply", "status", "inbox"] },
        threadId: {
          ...text,
          description:
            'Destination threadId from list_active_threads for action "send".',
        },
        replyTo: {
          ...text,
          description: "The original messageId received by this conversation.",
        },
        body: {
          ...text,
          maxLength: 65536,
          description: "Message text for send or reply.",
        },
        requestId: {
          ...text,
          maxLength: 160,
          description:
            "Unique string you choose for each new send or reply, such as restart-eta-20261126-01 or a UUID. Reuse it on an identical retry to prevent duplication and get the same messageId. Required in Claude Code. Codex can supply its native tool call ID when available.",
        },
        messageId: {
          ...text,
          description:
            'Claudex-assigned identifier for action "status". Supply a received messageId as replyTo when replying.',
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

export function conversationCollaborationInstructions(serverName) {
  return [
    `Use the ${serverName} MCP server when the user asks to coordinate or this task involves overlapping work, resource contention, information exchange, or a handoff with an active conversation. Start with list_active_threads in your workspace.`,
    'Workspace scope is the default. Use global only when the task genuinely requires another workspace. After selecting a conversation, use thread_chat to ask it a question. Set action to "send" and fill in the target threadId returned by list_active_threads.',
    "Send one concrete ask with the context the peer needs. After asking, continue work that can proceed without waiting for the reply. If all remaining work depends on the reply, end your turn. When the peer sends a reply, Claudex immediately pushes it back to this conversation. If your turn has ended, Claudex starts a new turn in this conversation.",
    "Choose a unique requestId string for each new send or reply, such as restart-eta-20261126-01 or a UUID. If a timeout or disconnect leaves you without confirmation that your submission was saved, retry with the same arguments and requestId. When Claudex sees the same sender and requestId, it reuses the saved submission and prevents a duplicate.",
    'When another conversation asks a question, reply immediately if you have enough facts. Each question includes a messageId. Use thread_chat with action "reply", the received messageId as replyTo, and your answer as body. If you need more facts, gather them with the necessary tools, then reply. Send the reply directly without waiting for a separate user instruction, authorization, or approval.',
    'If you still need more information about delivery, use thread_chat with action "status" to troubleshoot delivery by messageId, or action "inbox" to recover an incoming message.',
  ].join("\n");
}

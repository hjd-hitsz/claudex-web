export function isClaudeCompaction(message) {
  return (
    message.type === "system" &&
    message.subtype === "compact_boundary" &&
    !message.parent_tool_use_id &&
    !message.isSidechain &&
    !message.isReplay &&
    Boolean(message.uuid)
  );
}

export function countClaudeCompactions(messages) {
  return new Set(messages.filter(isClaudeCompaction).map(({ uuid }) => uuid))
    .size;
}

import { createSessionReader } from "./history.mjs";

export function createClaudeToolRecordsReader(backend, thread) {
  const read = createSessionReader(backend);
  let history;
  return async ({ id: callId, nativeInputId, nativeOutputId }) => {
    if (!thread.initialized || (!nativeInputId && !nativeOutputId)) return [];
    history ??= read(
      "getSessionMessages",
      thread.nativeSessionId || thread.id,
      {
        dir: thread.historySearchAll ? undefined : thread.cwd,
        includeSystemMessages: true,
      },
    );
    const messages = await history;
    return messages.flatMap(({ uuid, timestamp, type, message }) => {
      if (!Array.isArray(message?.content)) return [];
      return message.content
        .filter(
          (block) =>
            (uuid === nativeInputId &&
              type === "assistant" &&
              block.type === "tool_use" &&
              block.id === callId) ||
            (uuid === nativeOutputId &&
              type === "user" &&
              block.type === "tool_result" &&
              block.tool_use_id === callId),
        )
        .map((block) => ({ uuid, timestamp, type, block }));
    });
  };
}

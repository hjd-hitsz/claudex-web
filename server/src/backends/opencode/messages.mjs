export function messageItems(message) {
  if (
    message.type === "user" ||
    (message.type === "synthetic" && message.metadata?.claudexGoalId)
  )
    return [
      {
        id: message.id,
        type: "userMessage",
        ...(message.type === "synthetic" && { authorLabel: "目标续跑" }),
        content: [
          { type: "text", text: message.text },
          ...(message.files || []).map((file) => ({
            type: "image",
            url: file.uri,
          })),
        ],
      },
    ];
  if (message.type === "compaction")
    return [{ id: message.id, type: "contextCompaction" }];
  if (message.type !== "assistant") return [];
  return message.content.flatMap((part, ordinal) => {
    const id = `${message.id}:${ordinal}`;
    if (part.type === "text")
      return {
        id,
        type: message.agent === "plan" ? "plan" : "agentMessage",
        text: part.text,
        phase: message.finish === "stop" ? "final_answer" : "commentary",
      };
    if (part.type === "reasoning")
      return {
        id,
        type: "reasoning",
        summary: [{ type: "summary_text", text: part.text }],
        content: [],
      };
    const state = part.state;
    if (part.name === "subagent" && state.metadata?.sessionID)
      return {
        id: part.id,
        type: "subAgentActivity",
        kind: state.status === "completed" ? "completed" : "started",
        agentThreadId: state.metadata.sessionID,
        agentPath:
          state.input?.agent || state.input?.description || "OpenCode 子代理",
        prompt: state.input?.prompt || state.input?.description,
      };
    const output = (state.content || [])
      .map((entry) => entry.text || "")
      .join("\n");
    return {
      id: part.id,
      type: "mcpToolCall",
      server: "OpenCode",
      tool: part.name,
      arguments: state.input || {},
      result: state.status === "completed" ? { content: state.content } : null,
      error:
        state.status === "error"
          ? {
              message:
                state.error?.message || String(state.error || "工具执行失败"),
            }
          : null,
      status:
        state.status === "completed"
          ? "completed"
          : state.status === "error"
            ? "failed"
            : "inProgress",
      output,
    };
  });
}
export function historyTurns(messages, active = false) {
  const turns = [];
  let turn;
  for (const message of messages) {
    if (
      (message.type === "user" || message.type === "synthetic") &&
      (!turn || turn.status !== "inProgress")
    ) {
      turn = {
        id: message.metadata?.claudexTurnId || message.id,
        status: "inProgress",
        items: [],
        startedAt: message.time.created / 1000,
      };
      turns.push(turn);
    }
    if (!turn) continue;
    turn.items.push(...messageItems(message));
    if (message.type === "idle") {
      turn.status = {
        succeeded: "completed",
        failed: "failed",
        interrupted: "interrupted",
      }[message.outcome];
      turn.completedAt = message.time.created / 1000;
      if (message.error)
        turn.error = {
          message: message.error.message || JSON.stringify(message.error),
        };
    }
  }
  if (turn?.status === "inProgress" && !active) turn.status = "interrupted";
  return turns;
}
export function page(data, params = {}) {
  const offset = Number(params.cursor || 0);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("分页位置无效");
  const limit = Math.max(1, Math.min(params.limit || 50, 200));
  const items = params.sortDirection === "desc" ? data.slice().reverse() : data;
  return {
    data: items.slice(offset, offset + limit),
    nextCursor: offset + limit < items.length ? String(offset + limit) : null,
  };
}
export async function allMessages(sdk, sessionID) {
  const data = [];
  let cursor;
  do {
    const result = await sdk.message.list({
      sessionID,
      limit: 200,
      ...(cursor ? { cursor } : { order: "asc" }),
    });
    data.push(...result.data);
    cursor = result.cursor.next;
  } while (cursor);
  return data;
}
function nativeTokens(t) {
  const total = {
    inputTokens: t.input + (t.cache?.read || 0) + (t.cache?.write || 0),
    outputTokens: t.output + t.reasoning,
    reasoningOutputTokens: t.reasoning,
    cachedInputTokens: t.cache?.read || 0,
  };
  total.totalTokens = total.inputTokens + total.outputTokens;
  return total;
}
export function tokenUsage(session, model, last) {
  return {
    total: nativeTokens(session.tokens),
    last: last?.tokens ? nativeTokens(last.tokens) : null,
    modelContextWindow: model?.limit?.context || null,
  };
}

import type {
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ActiveExecution, ExecutionTurn } from "./execution-types.d.mts";
import { executionError } from "./execution-errors.mjs";

export function automaticTurn(message: SDKMessage): ExecutionTurn | undefined {
  const nativeMessageId =
    message.type === "stream_event" && message.event.type === "message_start"
      ? message.event.message.id
      : message.type === "assistant"
        ? message.message.id
        : undefined;
  const anchor = nativeMessageId || message.uuid;
  if (!anchor) return;
  return {
    id: anchor,
    nativeAnchorId: anchor,
    nativeMessageIds: message.uuid ? [anchor, message.uuid] : [anchor],
    automatic: true,
    status: "inProgress",
    startedAt: Date.now() / 1000,
    items: [],
    mode: "default",
  };
}

export function completeTurn(
  active: ActiveExecution,
  result?: SDKResultMessage | null,
  error?: unknown,
) {
  const { turn } = active;
  turn.status = active.interrupted
    ? "interrupted"
    : error || result?.is_error || (result && result.subtype !== "success")
      ? "failed"
      : "completed";
  if (turn.status === "failed") {
    const reason =
      result && ("errors" in result ? result.errors.join("\n") : result.result);
    turn.error = executionError(
      error || new Error(reason || "Claude 执行失败"),
    );
  }
  turn.completedAt = Date.now() / 1000;
  return turn;
}

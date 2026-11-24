import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// CLI 会话持续持有输入流，轮次空闲时保持打开，直到显式关闭。
export function createInputStream() {
  const pending: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(message: SDKUserMessage) {
      if (closed) throw new Error("Claude 会话已关闭");
      pending.push(message);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (!pending.length)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        wake = null;
        while (pending.length) yield pending.shift()!;
      }
    },
  };
}

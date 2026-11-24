import type { Query } from "@anthropic-ai/claude-agent-sdk";

export function warmFileSuggestions(query: Query): Promise<unknown> {
  // 文件索引预热使用已安装 SDK 暴露的原生 request 通道。
  if (!("request" in query) || typeof query.request !== "function")
    throw new Error("Claude 原生文件索引控制接口不可用");
  return query.request({ subtype: "file_suggestions", query: "" });
}

export function interruptQueuedInput(query: Query) {
  // SDK 运行实现接受 cancelQueued 并发送 cancel_queued，公开声明省略该参数。
  const interrupt: (options: {
    cancelQueued: true;
  }) => ReturnType<Query["interrupt"]> = query.interrupt.bind(query);
  return interrupt({ cancelQueued: true });
}

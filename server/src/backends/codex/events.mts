import WebSocket from "ws";
import { threadMethods } from "./methods.mjs";
import type { CompactionTurn } from "../../../../shared/compaction-state.mjs";
import type { createCompactions } from "../../compaction.mjs";
import type { NativeEvent, RpcMessage } from "./native-protocol.d.mts";
import type { createStreamingMessages } from "./streaming-messages.mjs";
import type { createSubscriptions } from "./subscriptions.mjs";
import type { createCodexTurnUsage } from "./turn-usage.mjs";
import type { CodexClient, ForwardedRequest } from "./upstream.mjs";

type Goal = { status?: string };
type Thread = { id: string; status?: { type: string } };
type ResponseFields = Record<string, unknown> & {
  thread?: Thread;
  turn?: CompactionTurn;
  goal?: Goal;
  exitCode?: number | null;
};
type BridgeDependencies = Pick<
  ReturnType<typeof createSubscriptions>,
  "subscriptions" | "unwrittenThreads" | "updateGoal" | "releaseUnusedThreads"
> & {
  questions: Map<string, RpcMessage>;
  activeTurns: Map<string, string>;
  executionStatuses: Map<
    string,
    { turnId: string; kind: "retrying"; message: string }
  >;
  activeThreads: Set<string>;
  terminals: Map<string, { buffer: string; running: boolean }>;
  compactions: ReturnType<typeof createCompactions>;
  streamingMessages: Pick<ReturnType<typeof createStreamingMessages>, "read">;
  turnUsage?: ReturnType<typeof createCodexTurnUsage>;
  threadNaming: {
    cancel(threadId?: string): void;
    schedule(
      thread?: Pick<Thread, "id">,
      options?: { text?: string; model?: string },
    ): void;
  };
  send: (client: CodexClient, message: RpcMessage) => void;
  broadcast: (message: RpcMessage) => void;
  state: () => RpcMessage;
};

const modelItems = new Set(["agentMessage", "plan", "reasoning"]);
const modelProgress = new Set([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
]);
// 已启动的工具仍可独立输出和结束，新的工具调用才表明模型恢复进展。
const modelToolStarts = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageGeneration",
]);

export function createBridgeEvents({
  questions,
  activeTurns,
  executionStatuses,
  activeThreads,
  terminals,
  subscriptions,
  unwrittenThreads,
  updateGoal,
  compactions,
  streamingMessages,
  turnUsage,
  threadNaming,
  send,
  broadcast,
  state,
  releaseUnusedThreads,
}: BridgeDependencies) {
  function onEvent(message: NativeEvent) {
    if (message.id !== undefined) questions.set(String(message.id), message);
    const { method } = message;
    const p = message.params || {};
    const { threadId, turn } = p;
    if (method === "error" && p.willRetry === true) {
      if (threadId && p.turnId && activeTurns.get(threadId) === p.turnId) {
        const status = {
          turnId: p.turnId,
          kind: "retrying" as const,
          message: p.error?.message || "正在重试模型请求…",
        };
        executionStatuses.set(threadId, status);
        broadcast({
          method: "lan/executionStatus",
          params: { threadId, ...status },
        });
      }
      return;
    }
    if (
      threadId &&
      p.turnId &&
      executionStatuses.get(threadId)?.turnId === p.turnId &&
      (method === "error" ||
        modelProgress.has(method) ||
        (method === "item/started" &&
          (modelItems.has(p.item?.type ?? "") ||
            modelToolStarts.has(p.item?.type ?? ""))) ||
        (method === "item/completed" &&
          (modelItems.has(p.item?.type ?? "") ||
            p.item?.type === "contextCompaction")))
    ) {
      executionStatuses.delete(threadId);
      broadcast({
        method: "lan/executionStatus",
        params: { threadId, turnId: p.turnId, kind: "working" },
      });
    }
    if (
      ["thread/name/updated", "thread/deleted", "thread/archived"].includes(
        message.method,
      )
    )
      threadNaming.cancel(threadId);
    if (message.method === "turn/started" && threadId && turn) {
      if (executionStatuses.get(threadId)?.turnId !== turn.id)
        executionStatuses.delete(threadId);
      activeTurns.set(threadId, turn.id);
      activeThreads.add(threadId);
      unwrittenThreads.delete(threadId);
    }
    if (
      message.method === "turn/completed" &&
      threadId &&
      turn &&
      (!activeTurns.has(threadId) || activeTurns.get(threadId) === turn.id)
    ) {
      activeTurns.delete(threadId);
      activeThreads.delete(threadId);
      executionStatuses.delete(threadId);
    }
    if (message.method === "thread/status/changed" && threadId && p.status) {
      if (p.status.type === "active") activeThreads.add(threadId);
      else activeThreads.delete(threadId);
    }
    if (message.method === "thread/goal/updated" && threadId)
      updateGoal(threadId, p.goal ?? null);
    if (message.method === "thread/goal/cleared" && threadId)
      updateGoal(threadId, null);
    if (
      threadId &&
      ["thread/closed", "thread/deleted", "thread/archived"].includes(
        message.method,
      )
    ) {
      subscriptions.delete(threadId);
      unwrittenThreads.delete(threadId);
      updateGoal(threadId, null);
      activeThreads.delete(threadId);
      activeTurns.delete(threadId);
      executionStatuses.delete(threadId);
      if (message.method !== "thread/closed")
        compactions.entries.delete(threadId);
    }
    const terminal = p.processId ? terminals.get(p.processId) : undefined;
    if (
      message.method === "command/exec/outputDelta" &&
      terminal &&
      typeof p.deltaBase64 === "string"
    ) {
      terminal.buffer = (
        terminal.buffer + Buffer.from(p.deltaBase64, "base64").toString("utf8")
      ).slice(-200000);
    }
    if (message.method === "serverRequest/resolved") {
      questions.delete(String(p.requestId));
      broadcast(state());
    }
    broadcast(message);
    if (
      method === "item/completed" &&
      p.item?.type === "contextCompaction" &&
      threadId
    )
      void turnUsage?.compactionCount(threadId).then(
        (compactCount) =>
          broadcast({
            method: "thread/tokenUsage/updated",
            params: { threadId, turnId: p.turnId, compactCount },
          }),
        (error) =>
          console.error("读取 Codex 上下文压缩次数失败", error.message),
      );
    compactions.event(message.method, p);
    releaseUnusedThreads();
    if (message.method === "turn/completed" && threadId)
      threadNaming.schedule({ id: threadId });
    return;
  }
  function onResponse(request: ForwardedRequest, message: RpcMessage) {
    // 只读取桥接状态所需的原生字段，转发时沿用完整结果。
    const result = message.result as ResponseFields | undefined;
    if (!message.error && request.threadId) {
      if (request.method === "thread/goal/set" && result?.goal)
        updateGoal(request.threadId, result.goal);
      if (request.method === "thread/goal/clear")
        updateGoal(request.threadId, null);
    }
    if (
      message.error &&
      request.method === "thread/compact/start" &&
      request.threadId &&
      message.id !== undefined
    )
      compactions.reject(request.threadId, message.id, message.error.message);
    if (
      !message.error &&
      threadMethods.has(request.method) &&
      result?.thread?.id
    ) {
      const { thread } = result;
      const owners = subscriptions.get(thread.id) ?? new Set<CodexClient>();
      subscriptions.set(thread.id, owners);
      if (!request.timedOut && request.client.readyState === WebSocket.OPEN)
        owners.add(request.client);
      if (request.method === "thread/start") unwrittenThreads.add(thread.id);
      if (thread.status?.type === "active") activeThreads.add(thread.id);
    }
    if (request.threadId && result?.turn?.status === "inProgress") {
      activeTurns.set(request.threadId, result.turn.id);
      activeThreads.add(request.threadId);
    }
    if (
      !message.error &&
      request.threadId &&
      ["turn/start", "thread/compact/start", "review/start"].includes(
        request.method,
      )
    )
      unwrittenThreads.delete(request.threadId);
    const terminal = request.processId
      ? terminals.get(request.processId)
      : undefined;
    if (terminal) {
      terminal.running = false;
      broadcast({
        method: "lan/terminalExit",
        params: {
          processId: request.processId || undefined,
          exitCode: result?.exitCode,
        },
      });
    }
    if (!request.timedOut) {
      const streamed =
        request.includeStreaming && request.threadId
          ? streamingMessages.read(request.threadId)
          : [];
      const respond = (result?: ResponseFields) =>
        send(request.client, {
          ...message,
          id: request.id,
          ...(result && {
            result: request.includeStreaming
              ? { ...result, streamingMessages: streamed }
              : result,
          }),
        });
      if (request.method === "thread/turns/list" && turnUsage && result)
        void turnUsage.project(request.threadId, result).then(respond);
      else respond(result);
    }
    releaseUnusedThreads();
    if (!message.error && !request.timedOut && !request.client?.readOnly) {
      if (request.method === "turn/start" && request.threadId)
        threadNaming.schedule(
          { id: request.threadId },
          { text: request.nameText, model: request.model },
        );
      else if (["thread/read", "thread/resume"].includes(request.method))
        threadNaming.schedule(result?.thread);
    }
  }
  return { onEvent, onResponse };
}

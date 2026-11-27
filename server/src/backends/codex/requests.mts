import { terminalMethods } from "./background-terminals.mjs";
import { MAX_RPC_MESSAGE_BYTES } from "../../rpc-transport.mjs";
import { threadMethods, loadedThreadMethods } from "./methods.mjs";
import { assertConversationOperation } from "../../bridge/conversation-policy.mjs";
import { hasResumeTarget } from "./upstream.mjs";
import type { CodexClient, createUpstream } from "./upstream.mjs";
import type { NativeParams, RpcMessage } from "./native-protocol.d.mts";
import type { createSubscriptions } from "./subscriptions.mjs";
import type { createCompactions } from "../../compaction.mjs";

type LocalHandlers = ReadonlyMap<string, (params: NativeParams) => unknown>;
type RequestDependencies = Pick<
  ReturnType<typeof createSubscriptions>,
  | "subscriptions"
  | "releasing"
  | "resuming"
  | "resumeForWrite"
  | "retainThread"
  | "secretaryTurn"
  | "releaseUnusedThreads"
> & {
  transport: ReturnType<typeof createUpstream>;
  compactions: Pick<
    ReturnType<typeof createCompactions>,
    "busy" | "start" | "reject"
  >;
  threadNaming: { cancel(threadId?: string): void };
  activeTurns: ReadonlyMap<string, string>;
  activeThreads: ReadonlySet<string>;
  terminals: Map<string, { buffer: string; running: boolean }>;
  questions: Map<string, RpcMessage>;
  undoing: ReadonlySet<string>;
  backgroundCall?:
    false | ((method: string, params?: NativeParams) => Promise<unknown>);
  waitForBackgroundHandoff: (threadId: string) => Promise<unknown>;
  includeBackground: () => boolean;
  offline: LocalHandlers;
  online: LocalHandlers;
  send: (client: CodexClient, message: RpcMessage) => void;
  broadcast: (message: RpcMessage) => void;
};

export function createRequestHandler({
  transport,
  compactions,
  threadNaming,
  activeTurns,
  activeThreads,
  terminals,
  questions,
  undoing,
  subscriptions,
  releasing,
  resuming,
  resumeForWrite,
  retainThread,
  secretaryTurn,
  releaseUnusedThreads,
  backgroundCall,
  waitForBackgroundHandoff,
  includeBackground,
  offline,
  online,
  send,
  broadcast,
}: RequestDependencies) {
  function sendError(
    client: CodexClient,
    request: RpcMessage,
    message: string,
    code = -32000,
  ) {
    send(client, { id: request.id, error: { code, message } });
  }
  async function dispatchLocal(
    handlers: LocalHandlers,
    client: CodexClient,
    message: RpcMessage,
  ) {
    if (!message.method) return false;
    const handle = handlers.get(message.method);
    if (!handle) return false;
    try {
      send(client, {
        id: message.id,
        result: await handle(message.params || {}),
      });
    } catch (error) {
      sendError(
        client,
        message,
        error instanceof Error ? error.message : String(error),
      );
    }
    return true;
  }
  return async function handleRequest(
    client: CodexClient,
    message: RpcMessage,
    secretaryRole?: string,
  ) {
    if (await dispatchLocal(offline, client, message)) return;
    const threadId = message.params?.threadId;
    if (
      threadId &&
      message.method === "thread/resume" &&
      resuming.has(threadId)
    )
      await resuming.get(threadId);
    if (threadId && releasing.has(threadId)) await releasing.get(threadId);
    if (!transport.ready)
      return sendError(client, message, "正在连接 Codex，请稍后重试。");
    if (await dispatchLocal(online, client, message)) return;
    if (message.method) {
      try {
        assertConversationOperation(message.method, {
          compacting: compactions.busy(threadId),
          undoing: threadId !== undefined && undoing.has(threadId),
          active:
            threadId !== undefined &&
            (activeTurns.has(threadId) || activeThreads.has(threadId)),
          pending: [...transport.pending.values()].some(
            (request) =>
              request.threadId === threadId &&
              ["turn/start", "review/start"].includes(request.method),
          ),
        });
      } catch (error) {
        return sendError(
          client,
          message,
          error instanceof Error ? error.message : String(error),
        );
      }

      if (
        !threadId &&
        (message.method === "thread/unsubscribe" ||
          message.method === "thread/compact/start")
      )
        return sendError(client, message, "请求缺少对话标识。", -32602);
      if (
        ["thread/name/set", "thread/delete", "thread/archive"].includes(
          message.method,
        )
      )
        threadNaming.cancel(threadId);
      if (message.method === "thread/unsubscribe") {
        if (!threadId) return;
        subscriptions.get(threadId)?.delete(client);
        releaseUnusedThreads();
        const result = await releasing.get(threadId);
        send(client, {
          id: message.id,
          result: result || { status: "unsubscribed" },
        });
        return;
      }
      if (threadMethods.has(message.method))
        message.params = {
          ...message.params,
          config: { ...message.params?.config, thread_unload_delay_secs: 0 },
        };
      if (
        message.method === "thread/list" &&
        message.params?.modelProviders === undefined
      )
        message.params = { ...message.params, modelProviders: [] };
      const includeStreaming =
        Boolean(threadId) &&
        ["thread/items/list", "thread/turns/list"].includes(message.method) &&
        !message.params?.cursor &&
        message.params?.includeStreaming === true;
      if (message.params && Object.hasOwn(message.params, "includeStreaming")) {
        const { includeStreaming: _includeStreaming, ...params } =
          message.params;
        message.params = params;
      }
      if (
        backgroundCall &&
        threadId &&
        terminalMethods.has(message.method) &&
        includeBackground()
      ) {
        const release = retainThread(threadId);
        try {
          await resumeForWrite(threadId);
          await waitForBackgroundHandoff(threadId);
          send(client, {
            id: message.id,
            result: await backgroundCall(message.method, message.params),
          });
        } catch (error) {
          sendError(
            client,
            message,
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          release();
        }
        return;
      }
      const id = transport.nextId();
      let forwarded = JSON.stringify({ ...message, id });
      if (Buffer.byteLength(forwarded) > MAX_RPC_MESSAGE_BYTES)
        return sendError(
          client,
          message,
          "单次消息过大（最多 64 MiB），请减少附件后重试。",
          -32600,
        );
      const processId =
        message.method === "command/exec" && message.params?.processId;
      if (processId) {
        terminals.set(processId, { buffer: "", running: true });
        broadcast({ method: "lan/terminalStarted", params: { processId } });
      }
      const timer = processId
        ? null
        : setTimeout(() => {
            const request = transport.pending.get(id);
            if (
              request &&
              threadMethods.has(request.method) &&
              !request.waitingForClose
            )
              request.timedOut = true;
            else {
              transport.pending.delete(id);
              releaseUnusedThreads();
            }
            sendError(
              client,
              message,
              "请求等待超时；任务可能仍在继续，请刷新会话查看。",
            );
          }, 120000);
      transport.pending.set(id, {
        client,
        id: message.id,
        timer,
        processId,
        method: message.method,
        threadId,
        includeStreaming,
        secretaryRole,
        ...(message.method === "thread/resume" &&
          hasResumeTarget(message.params) && {
            resumeParams: message.params,
          }),
        ...(message.method === "turn/start" && {
          nameText: (message.params?.input || [])
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n"),
          model: message.params?.model,
        }),
      });
      if (message.method === "thread/compact/start" && threadId)
        compactions.start(threadId, id);
      if (threadId && loadedThreadMethods.has(message.method)) {
        try {
          await resumeForWrite(
            threadId,
            message.method === "mcpServerStatus/list"
              ? { inheritPermissions: true }
              : { cwd: message.params?.cwd },
          );
          if (message.method === "turn/start" && message.params) {
            const params = secretaryTurn(threadId, message.params);
            if (params !== message.params)
              forwarded = JSON.stringify({ ...message, params, id });
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (message.method === "thread/compact/start")
            compactions.reject(threadId, id, reason);
          clearTimeout(timer ?? undefined);
          if (transport.pending.delete(id)) sendError(client, message, reason);
          releaseUnusedThreads();
          return;
        }
        if (!transport.pending.has(id)) {
          releaseUnusedThreads();
          return;
        }
      }
      if (Buffer.byteLength(forwarded) > MAX_RPC_MESSAGE_BYTES) {
        clearTimeout(timer ?? undefined);
        transport.pending.delete(id);
        releaseUnusedThreads();
        return sendError(
          client,
          message,
          "单次消息过大（最多 64 MiB），请减少附件后重试。",
          -32600,
        );
      }
      transport.sendText(forwarded);
    } else if (message.id !== undefined && questions.has(String(message.id))) {
      transport.send(message);
      questions.delete(String(message.id));
      broadcast({ method: "lan/questionResolved", params: { id: message.id } });
    }
  };
}

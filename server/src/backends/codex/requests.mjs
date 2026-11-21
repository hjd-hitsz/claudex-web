import { terminalMethods } from "./background-terminals.mjs";
import { MAX_RPC_MESSAGE_BYTES } from "../../rpc-transport.mjs";
import { threadMethods, loadedThreadMethods } from "./methods.mjs";
import { assertConversationOperation } from "../../bridge/conversation-policy.mjs";
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
  resumeForWrite,
  retainThread,
  releaseUnusedThreads,
  backgroundCall,
  waitForBackgroundHandoff,
  includeBackground,
  offline,
  online,
  send,
  broadcast,
}) {
  function sendError(client, request, message, code = -32000) {
    send(client, { id: request.id, error: { code, message } });
  }
  async function dispatchLocal(handlers, client, message) {
    const handle = handlers.get(message.method);
    if (!handle) return false;
    try {
      send(client, {
        id: message.id,
        result: await handle(message.params || {}),
      });
    } catch (error) {
      sendError(client, message, error.message);
    }
    return true;
  }
  return async function handleRequest(client, message) {
    if (await dispatchLocal(offline, client, message)) return;
    const threadId = message.params?.threadId;
    if (threadId && releasing.has(threadId)) await releasing.get(threadId);
    if (!transport.ready)
      return sendError(client, message, "正在连接 Codex，请稍后重试。");
    if (await dispatchLocal(online, client, message)) return;
    if (message.method) {
      try {
        assertConversationOperation(message.method, {
          compacting: compactions.busy(threadId),
          undoing: undoing.has(threadId),
          active: activeTurns.has(threadId) || activeThreads.has(threadId),
          pending: [...transport.pending.values()].some(
            (request) =>
              request.threadId === threadId &&
              ["turn/start", "review/start"].includes(request.method),
          ),
        });
      } catch (error) {
        return sendError(client, message, error.message);
      }

      if (
        ["thread/name/set", "thread/delete", "thread/archive"].includes(
          message.method,
        )
      )
        threadNaming.cancel(threadId);
      if (message.method === "thread/unsubscribe") {
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
      if (
        backgroundCall &&
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
          sendError(client, message, error.message);
        } finally {
          release();
        }
        return;
      }
      const id = transport.nextId();
      const forwarded = JSON.stringify({ ...message, id });
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
            if (threadMethods.has(message.method) && !request?.waitingForClose)
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
        ...(message.method === "thread/resume" && {
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
      if (message.method === "thread/compact/start")
        compactions.start(threadId, id);
      if (threadId && loadedThreadMethods.has(message.method)) {
        try {
          await resumeForWrite(
            threadId,
            message.method === "mcpServerStatus/list"
              ? { inheritPermissions: true }
              : { cwd: message.params?.cwd },
          );
        } catch (error) {
          if (message.method === "thread/compact/start")
            compactions.reject(threadId, id, error.message);
          clearTimeout(timer);
          if (transport.pending.delete(id))
            sendError(client, message, error.message);
          releaseUnusedThreads();
          return;
        }
        if (!transport.pending.has(id)) {
          releaseUnusedThreads();
          return;
        }
      }
      transport.sendText(forwarded);
    } else if (message.id !== undefined && questions.has(String(message.id))) {
      transport.send(message);
      questions.delete(String(message.id));
      broadcast({ method: "lan/questionResolved", params: { id: message.id } });
    }
  };
}

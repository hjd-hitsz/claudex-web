import WebSocket from "ws";
import { sendRpcText } from "../../rpc-transport.mjs";
import { createResumeLifecycle } from "./resume-lifecycle.mjs";
import type { ResumeState } from "./resume-lifecycle.mjs";
import type {
  CallParams,
  CallResult,
  NativeEvent,
  NativeParams,
  RequestId,
  ResumeParams,
  RpcError,
  RpcMessage,
} from "./native-protocol.d.mts";

export class CodexRpcError extends Error {
  readonly code: number;

  constructor({ code, message }: RpcError) {
    super(message);
    this.code = code;
  }
}

export function hasResumeTarget(params?: NativeParams): params is ResumeParams {
  return typeof params?.threadId === "string";
}

export type CodexClient = { readyState: number; readOnly?: boolean };

type PendingCall = ResumeState & {
  timer: ReturnType<typeof setTimeout>;
  threadId?: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

export type ForwardedRequest = ResumeState & {
  id?: RequestId;
  client: CodexClient;
  timer: ReturnType<typeof setTimeout> | null;
  threadId?: string;
  processId?: string | false;
  includeStreaming: boolean;
  nameText?: string;
  model?: string;
  secretaryRole?: string;
};

type UpstreamOptions = {
  config: { upstreamUrl: string };
  version: { displayVersion: string };
  send: (client: CodexClient, message: RpcMessage) => void;
  onReady: () => void;
  onEvent: (message: NativeEvent) => void;
  onResponse: (request: ForwardedRequest, message: RpcMessage) => void;
  onSettled: () => void;
  onDisconnect: () => void;
  prepareParams?: (
    method: string,
    params: NativeParams,
  ) => Promise<NativeParams>;
};

type CallOptions = {
  trackThread?: boolean;
  timeoutMessage?: string;
  prepared?: boolean;
};

export function createUpstream({
  config,
  version,
  send,
  onReady,
  onEvent,
  onResponse,
  onSettled,
  onDisconnect,
  prepareParams,
}: UpstreamOptions) {
  const pending = new Map<number, PendingCall | ForwardedRequest>();
  let socket: WebSocket | undefined;
  let ready = false;
  let sequence = 1;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const nextId = () => sequence++;
  function sendText(text: string) {
    if (!socket) throw new Error("Codex 后端连接尚未建立");
    sendRpcText(socket, text);
  }
  const resumption = createResumeLifecycle({
    pending,
    send: (message) => sendText(JSON.stringify(message)),
  });

  function rejectPending(message: string) {
    for (const request of pending.values()) {
      clearTimeout(request.timer ?? undefined);
      if ("reject" in request) request.reject(new Error(message));
      else
        send(request.client, {
          id: request.id,
          error: { code: -32000, message },
        });
    }
    pending.clear();
  }

  function call<Method extends string>(
    method: Method,
    params: CallParams<NoInfer<Method>>,
    options?: CallOptions,
  ): Promise<CallResult<Method>>;
  function call(
    method: string,
    params: NativeParams,
    options?: CallOptions,
  ): Promise<unknown> {
    return prepareParams && !options?.prepared
      ? prepareParams(method, params).then((prepared) =>
          request(method, prepared, options),
        )
      : request(method, params, options);
  }

  function request(
    method: string,
    params: NativeParams,
    { trackThread = true, timeoutMessage = "恢复对话超时" }: CallOptions = {},
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const connection = socket;
      if (!connection) return reject(new Error("Codex 后端连接尚未建立"));
      const id = nextId();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(timeoutMessage));
      }, 120000);
      pending.set(id, {
        resolve,
        reject,
        timer,
        method,
        ...(method === "thread/resume" &&
          hasResumeTarget(params) && { resumeParams: params }),
        ...(trackThread && { threadId: params.threadId }),
      });
      sendRpcText(connection, JSON.stringify({ id, method, params }));
    });
  }

  function connect() {
    if (closed) return;
    const connection = new WebSocket(config.upstreamUrl);
    socket = connection;
    connection.on("open", () =>
      sendRpcText(
        connection,
        JSON.stringify({
          id: 0,
          method: "initialize",
          params: {
            clientInfo: {
              name: "claudex_web",
              title: "Claudex Web",
              version: version.displayVersion,
            },
            capabilities: { experimentalApi: true },
          },
        }),
      ),
    );
    connection.on("message", (bytes) => {
      if (socket !== connection || closed) return;
      const message: RpcMessage = JSON.parse(bytes.toString());
      if (message.id === 0 && !message.method) {
        if (message.error) {
          console.error("Initialization failed:", message.error.message);
          connection.close();
          return;
        }
        sendRpcText(connection, JSON.stringify({ method: "initialized" }));
        ready = true;
        onReady();
        return;
      }
      const { method, id } = message;
      if (method) {
        onEvent(message);
        if (
          method === "thread/closed" &&
          typeof message.params?.threadId === "string"
        )
          resumption.closed(message.params.threadId);
        return;
      }
      if (typeof id !== "number") return;
      const request = pending.get(id);
      if (!request) return;
      if (resumption.defer(id, request, message.error)) return;
      clearTimeout(request.timer ?? undefined);
      pending.delete(id);
      if ("resolve" in request) {
        if (message.error) request.reject(new CodexRpcError(message.error));
        else request.resolve(message.result);
        onSettled();
      } else onResponse(request, message);
    });
    connection.on("error", (error) =>
      console.error("App-server connection:", error.message),
    );
    connection.on("close", (code, reason) => {
      if (socket !== connection || closed) return;
      console.error(
        "App-server disconnected:",
        JSON.stringify({
          code,
          reason: reason.toString(),
          pendingMethods: [
            ...new Set([...pending.values()].map((request) => request.method)),
          ],
        }),
      );
      ready = false;
      rejectPending("Codex 后端连接中断，请重试。");
      onDisconnect();
      reconnectTimer = setTimeout(connect, 2000);
    });
  }

  function close() {
    closed = true;
    ready = false;
    clearTimeout(reconnectTimer);
    rejectPending("网页桥接已关闭");
    socket?.terminate();
  }

  return {
    call,
    connect,
    close,
    nextId,
    pending,
    send: (message: RpcMessage) => sendText(JSON.stringify(message)),
    sendText,
    get ready() {
      return ready;
    },
  };
}

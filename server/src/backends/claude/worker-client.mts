import { findCli } from "../cli-installation.mjs";
import net from "node:net";
import type { Socket } from "node:net";
import type { RpcMessage } from "../../rpc-message.d.mts";
import type { ProcessIdentity } from "./execution-types.d.mts";
import type {
  ConversationDelivery,
  ConversationEnvelope,
  ConversationTool,
} from "./conversation-protocol.d.mts";
import type {
  ConversationToolReply,
  Operation,
  Replacement,
  WorkerBackend,
  WorkerConfig,
  WorkerInput,
  WorkerOptions,
  WorkerPacket,
  WorkerResult,
  WorkerState,
} from "./worker-protocol.d.mts";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { claudeCapabilities } from "../../../../shared/backend-capabilities.mjs";
import { hasBackendWork } from "../../../../shared/backend-activity.mjs";
import { launchWorker, workerLocation } from "./worker-launcher.mjs";
import { workerRevision } from "./worker-revision.mjs";
import { readWorkerLines } from "./worker-lines.mjs";
import { networkProxyEnvironment } from "../network-proxy.mjs";
import { executionBackend } from "../../../../shared/subagent-settings.mjs";
import {
  captureNativeProcesses,
  nativeProcessesAlive,
} from "./process-ownership.mjs";
import {
  prepareWorkerDirectory,
  verifyWorkerSocket,
  workerConnectionError,
} from "./worker-location.mjs";

type WorkerAdapterOptions<Client> = {
  backend: WorkerBackend;
  config: WorkerConfig;
  send: (client: Client, message: RpcMessage) => void;
  broadcast: (message: WorkerState | RpcMessage) => void;
  callConversationTool?: ConversationTool;
};

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createClaudeWorkerAdapter<Client>({
  backend,
  config,
  send,
  broadcast,
  callConversationTool,
}: WorkerAdapterOptions<Client>) {
  const location = workerLocation(backend);
  const options: WorkerOptions = {
    generation: Date.now(),
    backend,
    runtimeEnv: {
      ...Object.fromEntries(
        [
          "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_MODEL",
          "ANTHROPIC_CUSTOM_HEADERS",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CODE_EFFORT_LEVEL",
          "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "ALL_PROXY",
          "NO_PROXY",
          "http_proxy",
          "https_proxy",
          "all_proxy",
          "no_proxy",
          "SSL_CERT_FILE",
          "SSL_CERT_DIR",
          "NODE_EXTRA_CA_CERTS",
          "NODE_USE_ENV_PROXY",
          "LANG",
          "LC_ALL",
        ]
          .filter((key) => process.env[key] !== undefined)
          .map((key) => [key, process.env[key]]),
      ),
      ...networkProxyEnvironment(backend.proxy),
    },
    config: {
      codexHome: config.codexHome,
      claudeHome: config.claudeHome,
      configDir: config.configDir,
      backendsFile: config.backendsFile,
      defaultCwd: config.defaultCwd,
      projectlessRoot: config.projectlessRoot,
    },
  };
  const pending = new Map<string, PendingRequest>();
  let socket: Socket | null = null;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let upgradeRetry: ReturnType<typeof setTimeout> | undefined;
  let connecting: Promise<void> | undefined;
  let workerPid: number | undefined;
  let workerIdentity: ProcessIdentity | null = null;
  let closed = false,
    stopping = false,
    outdated = false,
    upgrading = false,
    mayUpgrade = true;
  let snapshot: WorkerState = {
    method: "lan/state",
    params: {
      ready: false,
      error: null,
      activeTurns: {},
      questions: [],
      compactions: {},
      terminals: {},
      undoneFiles: [],
      backgroundTasks: {},
    },
  };
  function publish() {
    if (outdated && mayUpgrade)
      snapshot = {
        ...snapshot,
        params: { ...snapshot.params, pendingUpdate: true },
      };
    broadcast(snapshot);
  }
  function busy() {
    return hasBackendWork(snapshot.params);
  }
  function upgradeWhenIdle() {
    if (
      closed ||
      !socket ||
      socket.destroyed ||
      connecting ||
      stopping ||
      !outdated ||
      !mayUpgrade ||
      upgrading ||
      upgradeRetry ||
      busy() ||
      !options.revision
    )
      return;
    upgrading = true;
    shutdownWorker({ ...options, revision: options.revision })
      .then(() => connect().catch(() => {}))
      .catch((error) => {
        if (closed || !socket || socket.destroyed) return;
        if (error.code !== "EWORKERBUSY")
          console.error("Claude 执行服务替换暂缓：", error.message);
        upgradeRetry = setTimeout(() => {
          upgradeRetry = undefined;
          upgradeWhenIdle();
        }, 1000);
      })
      .finally(() => {
        upgrading = false;
        upgradeWhenIdle();
      });
  }
  function accept(connection: Socket, packet: WorkerPacket) {
    if (packet.kind === "conversationTool") {
      const answer = (reply: Omit<ConversationToolReply, "kind" | "id">) => {
        if (!connection.destroyed)
          connection.write(
            JSON.stringify({
              kind: "conversationToolReply",
              id: packet.id,
              ...reply,
            } satisfies ConversationToolReply) + "\n",
          );
      };
      if (!callConversationTool) answer({ error: "Claudex 会话管理器不可用" });
      else
        Promise.resolve()
          .then(() =>
            callConversationTool(packet.context, packet.name, packet.args),
          )
          .then(
            (result) => answer({ result }),
            (error) =>
              answer({
                error: error instanceof Error ? error.message : String(error),
              }),
          );
    }
    if (packet.kind === "state") {
      snapshot = packet.message;
      publish();
      upgradeWhenIdle();
    }
    if (packet.kind === "event") broadcast(packet.message);
    if (packet.kind === "response" && packet.id !== undefined) {
      const request = pending.get(packet.id);
      if (!request) return;
      pending.delete(packet.id);
      clearTimeout(request.timer);
      if (packet.error)
        request.reject(
          Object.assign(new Error(packet.error), { code: packet.errorCode }),
        );
      else request.resolve(packet.result);
    }
  }
  function request<Kind extends Operation>(
    value: WorkerInput<Kind>,
  ): Promise<WorkerResult<Kind>> {
    const connection = socket;
    if (!connection || connection.destroyed)
      return Promise.reject(new Error("Claude 后端连接已断开"));
    const id = randomUUID();
    return new Promise<WorkerResult<Kind>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Claude 后端请求超时，请核对实际任务状态。"));
      }, 120000);
      // IPC 按 ID 关联响应，服务端按同一操作表构造返回值。
      pending.set(id, {
        resolve: (result) => resolve(result as WorkerResult<Kind>),
        reject,
        timer,
      });
      connection.write(JSON.stringify({ ...value, id }) + "\n");
    });
  }
  async function open() {
    stopping = false;
    await prepareWorkerDirectory(location.directory);
    let connection: Socket;
    try {
      await verifyWorkerSocket(location.socket);
      connection = net.connect(location.socket);
      await new Promise<void>((resolve, reject) => {
        connection.once("connect", resolve);
        connection.once("error", reject);
      });
    } catch (error) {
      throw workerConnectionError(error);
    }
    socket = connection;
    let initializing = true;
    let latestState: WorkerState | undefined;
    readWorkerLines(connection, "Claude IPC 响应超过限制", (line) => {
      try {
        const packet: WorkerPacket = JSON.parse(line);
        if (initializing && packet.kind === "state")
          latestState = packet.message;
        else accept(connection, packet);
      } catch (error) {
        connection.destroy(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
    connection.on("error", () => {});
    connection.on("close", () => {
      if (socket !== connection) return;
      socket = null;
      clearTimeout(upgradeRetry);
      upgradeRetry = undefined;
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("Claude 后端连接中断，请核对实际任务状态。"));
      }
      pending.clear();
      snapshot = {
        ...snapshot,
        params: {
          ...snapshot.params,
          ready: false,
          error: "正在重新连接 Claude 后端…",
        },
      };
      if (!closed && !stopping) {
        publish();
        reconnect = setTimeout(() => connect().catch(() => {}), 1000);
      }
    });
    options.revision = await workerRevision();
    let initialized;
    try {
      initialized = await request({
        kind: "initialize",
        options,
        conversationTools: Boolean(callConversationTool),
      });
    } catch (error) {
      connection.destroy();
      throw error;
    }
    workerPid = initialized.pid;
    workerIdentity = (await captureNativeProcesses(workerPid)).owner;
    snapshot = latestState || initialized.state;
    outdated =
      initialized.revision?.entry !== options.revision.entry ||
      initialized.revision?.hash !== options.revision.hash ||
      (initialized.configuration !== undefined &&
        !isDeepStrictEqual(
          {
            ...initialized.configuration,
            backend: executionBackend(initialized.configuration.backend),
          },
          {
            backend: executionBackend(options.backend),
            config: options.config,
            runtimeEnv: options.runtimeEnv,
          },
        ));
    mayUpgrade =
      !initialized.generation || options.generation > initialized.generation;
    initializing = false;
    publish();
  }
  async function connect() {
    options.backend = {
      ...backend,
      executable:
        backend.executable === "claude"
          ? await findCli("claude")
          : backend.executable,
    };
    if (closed) return;
    if (connecting) return connecting;
    if (socket && !socket.destroyed) return;
    connecting = (async () => {
      try {
        await open();
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (!code || !["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(code))
          throw error;
      }
      await launchWorker(backend, options);
      let lastError;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (closed) return;
        try {
          await open();
          return;
        } catch (error) {
          lastError = error;
        }
        await delay(100);
      }
      throw lastError;
    })();
    try {
      await connecting;
    } catch (error) {
      if (error instanceof Error && error.cause)
        console.error("Claude 后台服务连接失败：", error.cause);
      snapshot = {
        ...snapshot,
        params: {
          ...snapshot.params,
          ready: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
      publish();
      if (!closed)
        reconnect = setTimeout(() => connect().catch(() => {}), 1000);
      throw error;
    } finally {
      connecting = undefined;
      upgradeWhenIdle();
    }
  }
  async function shutdownWorker(replacement?: Replacement) {
    if (!socket || socket.destroyed) return;
    if (stopping) throw new Error("Claude 后端正在停止。");
    const connection = socket;
    const { promise: ended, resolve: onClose } = Promise.withResolvers<void>();
    connection.once("close", onClose);
    stopping = true;
    try {
      await request({ kind: "shutdown", replacement });
      await ended;
      for (let attempt = 0; attempt < 250; attempt++) {
        if (
          !workerIdentity ||
          !(await nativeProcessesAlive({ nativeProcess: workerIdentity }))
        )
          return;
        await delay(20);
      }
      throw new Error("Claude 后端停止超时，请核对后端服务状态。");
    } catch (error) {
      connection.removeListener("close", onClose);
      stopping = false;
      if (!closed && (!socket || socket.destroyed))
        reconnect = setTimeout(() => connect().catch(() => {}), 1000);
      throw error;
    }
  }
  return {
    capabilities: claudeCapabilities,
    conversationManager: {
      listActive: () => request({ kind: "conversationList" }),
      readThread: (threadId: string) =>
        request({ kind: "conversationRead", threadId }),
      deliver(envelope: ConversationEnvelope): Promise<ConversationDelivery> {
        if (!socket || socket.destroyed || !snapshot.params.ready)
          return Promise.resolve({
            status: "deferred",
            reason: "Claude 执行服务尚未连接",
          });
        return request({ kind: "conversationDeliver", envelope }).catch(
          (error) => ({
            status: "unknown",
            reason: error.message,
          }),
        );
      },
      reconcile: (envelope: ConversationEnvelope) =>
        request({ kind: "conversationReconcile", envelope }),
    },
    workspaceOwner: "bridge",
    releaseClient() {},
    state: () => snapshot,
    get ready() {
      return Boolean(socket && !socket.destroyed && snapshot.params.ready);
    },
    get workerPid() {
      return workerPid;
    },
    connect,
    async receive(client: Client, message: RpcMessage) {
      try {
        const response = await request({ kind: "rpc", message });
        if (response) send(client, response);
      } catch (error) {
        if (message.method)
          send(client, {
            id: message.id,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            },
          });
      }
    },
    releaseUnusedThreads() {
      if (socket && !socket.destroyed)
        socket.write(
          JSON.stringify({
            kind: "release",
          } satisfies import("./worker-protocol.d.mts").WorkerRequest) + "\n",
        );
    },
    shutdown: shutdownWorker,
    close() {
      closed = true;
      clearTimeout(reconnect);
      clearTimeout(upgradeRetry);
      socket?.destroy();
    },
  };
}

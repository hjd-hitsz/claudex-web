import net from "node:net";
import type { Socket } from "node:net";
import { mkdir, readFile, chmod, lstat, unlink } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { writePrivateFile } from "../../private-file.mjs";
import { createClaudeAdapter } from "./adapter.mjs";
import { createBackendConfiguration } from "../configuration.mjs";
import { createProviders } from "../providers.mjs";
import { workerRevision } from "./worker-revision.mjs";
import { readWorkerLines } from "./worker-lines.mjs";
import { hasBackendWork } from "../../../../shared/backend-activity.mjs";
import type { RpcMessage } from "../../rpc-message.d.mts";
import type {
  Operation,
  Revision,
  WorkerOptions,
  WorkerPacket,
  WorkerRequest,
  WorkerResult,
  WorkerState,
} from "./worker-protocol.d.mts";
import {
  prepareWorkerDirectory,
  verifyWorkerSocket,
} from "./worker-location.mjs";

const [socketArgument, dataArgument, environmentPath] = process.argv.slice(2);
if (!socketArgument || !dataArgument)
  throw new Error("Claude worker requires a socket and data directory");
const socketPath = socketArgument;
const dataDir = dataArgument;
process.umask(0o077);
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await prepareWorkerDirectory(dirname(socketPath));
const optionsPath = join(dataDir, "worker-options.json");
type WorkerSocket = Socket & { initialized?: boolean };
const clients = new Set<WorkerSocket>();
const revision = await workerRevision();
let adapter: ReturnType<typeof createClaudeAdapter> | undefined;
let options:
  (WorkerOptions & { revision: Revision; preferredEntry: string }) | undefined;
let initializing: Promise<void> | undefined;
let closing = false;
let inflight = 0;
let stopping = false;
async function currentState(): Promise<WorkerState> {
  let sessions: Record<
    string,
    {
      backgroundTasks?: Record<string, { status: string }>;
      queue?: unknown[];
    }
  > = {};
  try {
    sessions = JSON.parse(
      await readFile(join(dataDir, "claudex-web-index.json"), "utf8"),
    ).sessions;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!adapter) throw new Error("Claude IPC 尚未初始化");
  const state = adapter.state();
  return {
    method: "lan/state",
    params: {
      ...state.params,
      backgroundTasks: Object.fromEntries(
        Object.entries(sessions)
          .map(
            ([id, session]) =>
              [
                id,
                Object.values(session.backgroundTasks || {}).filter((task) =>
                  ["running", "pending", "unknown"].includes(task.status),
                ),
              ] as const,
          )
          .filter(([, tasks]) => tasks.length),
      ),
      queuedInputs: Object.fromEntries(
        Object.entries(sessions)
          .filter(([, session]) => session.queue?.length)
          .map(([id, session]) => [id, session.queue?.length ?? 0]),
      ),
    },
  };
}
async function isBusy() {
  return Boolean(inflight || hasBackendWork((await currentState()).params));
}
function send(socket: WorkerSocket, value: WorkerPacket) {
  if (!socket.destroyed) socket.write(JSON.stringify(value) + "\n");
}
function reply<Kind extends Operation>(
  socket: WorkerSocket,
  request: { kind: Kind; id: string },
  result: WorkerResult<NoInfer<Kind>>,
) {
  send(socket, { kind: "response", id: request.id, result });
}

function broadcast(message: RpcMessage & { method: string }) {
  if (message.method !== "lan/state")
    for (const socket of clients)
      if (socket.initialized) send(socket, { kind: "event", message });
  if (message.method === "lan/state" || !/delta$/i.test(message.method))
    queueMicrotask(() => {
      if (adapter)
        for (const socket of clients)
          if (socket.initialized)
            currentState()
              .then((message) => send(socket, { kind: "state", message }))
              .catch((error) =>
                send(socket, { kind: "error", error: error.message }),
              );
    });
}
async function initialize(value: WorkerOptions) {
  if (initializing) await initializing;
  if (
    resolve(value.backend.stateDir) !== resolve(dataDir) ||
    value.backend.id !== "claude"
  )
    throw new Error("Claude 后端目录或标识不匹配");
  if (adapter) return;
  initializing = (async () => {
    options = { ...value, revision, preferredEntry: revision.entry };
    Object.assign(process.env, value.runtimeEnv || {});
    await writePrivateFile(optionsPath, JSON.stringify(options));
    const configuration = createBackendConfiguration(value.config);
    const providers = createProviders(configuration);
    adapter = createClaudeAdapter({
      ...value,
      providers,
      readSubagentSettings: () => configuration.readSubagentSettings("claude"),
      send: (
        client: { deliver(message: RpcMessage): void },
        message: RpcMessage,
      ) => client.deliver(message),
      broadcast,
      workspace: { handles: () => false, snapshot: () => ({}) },
    });
    await adapter.connect();
  })();
  try {
    await initializing;
  } finally {
    initializing = undefined;
  }
}
const server = net.createServer((socket) => {
  clients.add(socket);
  readWorkerLines(socket, "Claude IPC 请求超过限制", (line) => {
    handle(socket, line).catch((error) =>
      send(socket, { kind: "error", error: error.message }),
    );
  });
  socket.on("error", () => {});
  socket.on("close", () => clients.delete(socket));
});
async function handle(socket: WorkerSocket, line: string) {
  let request: WorkerRequest | undefined;
  try {
    request = JSON.parse(line) as WorkerRequest;
    if (request.kind === "initialize") {
      await initialize(request.options);
      const state = await currentState();
      if (!options) throw new Error("Claude IPC 尚未初始化");
      socket.initialized = true;
      reply(socket, request, {
        pid: process.pid,
        state,
        revision,
        busy: Boolean(inflight || hasBackendWork(state.params)),
        configuration: {
          backend: options.backend,
          config: options.config,
          runtimeEnv: options.runtimeEnv || {},
        },
        generation: options.generation,
      });
      return;
    }
    if (!socket.initialized || !adapter)
      throw new Error("Claude IPC 尚未初始化");
    if (request.kind === "state")
      return reply(socket, request, await currentState());
    if (request.kind === "release") {
      adapter.releaseUnusedThreads();
      return;
    }
    if (request.kind === "shutdown") {
      if (stopping) throw new Error("Claude 后端正在停止。");
      stopping = true;
      try {
        if (await isBusy()) {
          throw Object.assign(
            new Error(
              "Claude 后端仍有运行任务、排队输入或待答提问，请结束后再停止。",
            ),
            { code: "EWORKERBUSY" },
          );
        }
        if (request.replacement) {
          if (
            resolve(request.replacement.backend.stateDir) !== resolve(dataDir)
          )
            throw new Error("Claude 更新目录不匹配");
          await writePrivateFile(
            optionsPath,
            JSON.stringify({
              ...request.replacement,
              preferredEntry: request.replacement.revision.entry,
            }),
          );
        }
      } catch (error) {
        stopping = false;
        throw error;
      }
      reply(socket, request, {});
      return shutdown();
    }
    if (request.kind !== "rpc") throw new Error("未知 Claude IPC 操作");
    if (stopping) throw new Error("Claude 后端正在停止，请稍后重试。");
    const call = request;
    let replied = false;
    inflight++;
    try {
      await adapter.receive(
        {
          deliver(message: RpcMessage) {
            replied = true;
            reply(socket, call, message);
          },
        },
        request.message,
      );
    } finally {
      inflight--;
    }
    if (!replied) reply(socket, call, null);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    send(socket, {
      kind: "response",
      id:
        request && typeof request === "object" && "id" in request
          ? request.id
          : undefined,
      error: error instanceof Error ? error.message : String(error),
      errorCode: code,
    });
  }
}
async function listen() {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
}
try {
  await listen();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
  await verifyWorkerSocket(socketPath);
  const active = await new Promise<boolean>((resolve) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
  if (active) process.exit(0);
  const info = await lstat(socketPath);
  if (!info.isSocket() || info.uid !== process.getuid?.())
    throw new Error("Claude IPC socket 归属异常");
  await unlink(socketPath);
  await listen();
}
try {
  await initialize(JSON.parse(await readFile(optionsPath, "utf8")));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT")
    console.error("Claude 后端恢复失败", error);
}
const housekeeping = setInterval(() => adapter?.releaseUnusedThreads(), 30000);
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(housekeeping);
  adapter?.close();
  for (const socket of clients) socket.end();
  server.close();
  await unlink(socketPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (environmentPath)
    await unlink(environmentPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

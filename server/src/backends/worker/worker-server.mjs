import net from "node:net";
import { mkdir, readFile, chmod, lstat, unlink } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { writePrivateFile } from "../../private-file.mjs";
import { createBackendConfiguration } from "../configuration.mjs";
import { createProviders } from "../providers.mjs";
import { workerRevision } from "./worker-revision.mjs";
import { fileURLToPath } from "node:url";
import { readWorkerLines } from "./worker-lines.mjs";
import { hasBackendWork } from "../../../../shared/backend-activity.mjs";
import {
  prepareWorkerDirectory,
  verifyWorkerSocket,
} from "./worker-location.mjs";

export async function runWorker({
  backendId,
  createAdapter,
  entry,
  readState = (adapter) => adapter.state(),
}) {
  const [socketPath, dataDir, environmentPath] = process.argv.slice(2);
  if (!socketPath || !dataDir)
    throw new Error("原生 worker requires a socket and data directory");
  process.umask(0o077);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await prepareWorkerDirectory(dirname(socketPath));
  const optionsPath = join(dataDir, "worker-options.json");
  const clients = new Set();
  const revision = await workerRevision(fileURLToPath(entry));
  let adapter;
  let options;
  let initializing;
  let closing = false;
  let inflight = 0;
  let stopping = false;
  async function currentState() {
    return readState(adapter, dataDir);
  }
  async function isBusy() {
    return Boolean(inflight || hasBackendWork((await currentState()).params));
  }
  function send(socket, value) {
    if (!socket.destroyed) socket.write(JSON.stringify(value) + "\n");
  }
  function broadcast(message) {
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
  async function initialize(value) {
    if (initializing) await initializing;
    if (
      resolve(value.backend.stateDir) !== resolve(dataDir) ||
      value.backend.id !== backendId
    )
      throw new Error("原生 后端目录或标识不匹配");
    if (adapter) return;
    initializing = (async () => {
      options = { ...value, revision, preferredEntry: revision.entry };
      Object.assign(process.env, value.runtimeEnv || {});
      await writePrivateFile(optionsPath, JSON.stringify(options));
      const configuration = createBackendConfiguration(value.config);
      const providers = createProviders(configuration);
      adapter = createAdapter({
        ...value,
        providers,
        readSubagentSettings: () =>
          configuration.readSubagentSettings(backendId),
        send: (client, message) => client.deliver(message),
        broadcast,
        workspace: { handles: () => false, snapshot: () => ({}) },
      });
      await adapter.connect();
    })();
    try {
      await initializing;
    } finally {
      initializing = null;
    }
  }
  const server = net.createServer((socket) => {
    clients.add(socket);
    readWorkerLines(socket, "原生 IPC 请求超过限制", (line) => {
      handle(socket, line).catch((error) =>
        send(socket, { kind: "error", error: error.message }),
      );
    });
    socket.on("error", () => {});
    socket.on("close", () => clients.delete(socket));
  });
  async function handle(socket, line) {
    let request;
    try {
      request = JSON.parse(line);
      if (request.kind === "initialize") {
        await initialize(request.options);
        const state = await currentState();
        socket.initialized = true;
        send(socket, {
          kind: "response",
          id: request.id,
          result: {
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
          },
        });
        return;
      }
      if (!socket.initialized) throw new Error("原生 IPC 尚未初始化");
      if (request.kind === "state")
        return send(socket, {
          kind: "response",
          id: request.id,
          result: await currentState(),
        });
      if (request.kind === "release") {
        adapter.releaseUnusedThreads();
        return;
      }
      if (request.kind === "shutdown") {
        if (stopping) throw new Error("原生 后端正在停止。");
        stopping = true;
        try {
          if (await isBusy()) {
            throw Object.assign(
              new Error(
                "原生 后端仍有运行任务、排队输入或待答提问，请结束后再停止。",
              ),
              { code: "EWORKERBUSY" },
            );
          }
          if (request.replacement) {
            if (
              resolve(request.replacement.backend.stateDir) !== resolve(dataDir)
            )
              throw new Error("原生 更新目录不匹配");
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
        send(socket, { kind: "response", id: request.id, result: {} });
        return shutdown();
      }
      if (request.kind !== "rpc") throw new Error("未知 原生 IPC 操作");
      if (stopping) throw new Error("原生 后端正在停止，请稍后重试。");
      let replied = false;
      inflight++;
      try {
        await adapter.receive(
          {
            deliver(message) {
              replied = true;
              send(socket, {
                kind: "response",
                id: request.id,
                result: message,
              });
            },
          },
          request.message,
        );
      } finally {
        inflight--;
      }
      if (!replied)
        send(socket, { kind: "response", id: request.id, result: null });
    } catch (error) {
      send(socket, {
        kind: "response",
        id: request?.id,
        error: error.message,
        errorCode: error.code,
      });
    }
  }
  async function listen() {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
  }
  try {
    await listen();
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    await verifyWorkerSocket(socketPath);
    const active = await new Promise((resolve) => {
      const socket = net.connect(socketPath);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (active) process.exit(0);
    const info = await lstat(socketPath);
    if (!info.isSocket() || info.uid !== process.getuid())
      throw new Error("原生 IPC socket 归属异常");
    await unlink(socketPath);
    await listen();
  }
  try {
    await initialize(JSON.parse(await readFile(optionsPath, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") console.error("原生 后端恢复失败", error);
  }
  const housekeeping = setInterval(
    () => adapter?.releaseUnusedThreads(),
    30000,
  );
  async function shutdown() {
    if (closing) return;
    closing = true;
    clearInterval(housekeeping);
    await adapter?.close();
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
}

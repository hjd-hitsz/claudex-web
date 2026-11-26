import { createServer } from "node:net";
import { chmod, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  connectIpc,
  privateDirectory,
  receiveIpc,
  sendIpc,
} from "./worker-ipc.mjs";
import { createAgyAdapter } from "./adapter.mjs";
import { agyHistoryMethods } from "./delegation-history.mjs";
import { hasBackendWork } from "../../../../shared/backend-activity.mjs";

const [path, optionsPath] = process.argv.slice(2);
const { backend, config, version, runtimeEnv } = JSON.parse(
  await readFile(optionsPath, "utf8"),
);
Object.assign(process.env, runtimeEnv);
process.umask(0o077);
await privateDirectory(dirname(path));
await privateDirectory(backend.stateDir);

const subscribers = new Set();
const clients = new Set();
let closing = false;
let requests = 0;
const service = createAgyAdapter({
  backend,
  config,
  version,
  socket: path,
  emit: (event) => {
    for (const socket of subscribers) sendIpc(socket, { event });
  },
});
let started;
const initialized = new Promise((resolve) => {
  started = resolve;
});

async function dispatch(socket, method, params) {
  if (method === "state") {
    subscribers.add(socket);
    await initialized;
    const state = await service.state();
    state.params.pid = process.pid;
    return state;
  }
  if (method === "mcp/ready") return service.execution.mcpReady(params);
  if (method === "mcp/list") return service.execution.list(params);
  if (method === "mcp/call") return service.execution.submit(params);
  if (closing) throw new Error("agy 服务正在停止");
  if (method === "configure") {
    service.configure(params.backend);
    return service.state();
  }
  if (method === "shutdown") {
    closing = true;
    const { params: status } = await service.state();
    if (
      requests ||
      hasBackendWork(status) ||
      Object.keys(status.delegationTasks).length
    ) {
      closing = false;
      throw new Error("agy 仍有执行中的会话或委派任务");
    }
    setImmediate(shutdown);
    return {};
  }
  if (method !== "rpc") throw new Error("未知 agy 执行服务操作");
  if (!agyHistoryMethods.has(params.method) && params.method !== "thread/list")
    await initialized;
  requests++;
  try {
    return params.method
      ? await service.request(params.method, params.params || {})
      : await service.execution.respond(params);
  } finally {
    requests--;
  }
}

const listener = createServer((socket) => {
  clients.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => {
    subscribers.delete(socket);
    clients.delete(socket);
  });
  receiveIpc(socket, (request) => {
    Promise.resolve()
      .then(() => dispatch(socket, request.method, request.params))
      .then(
        (result) => sendIpc(socket, { id: request.id, result: result ?? null }),
        (error) => sendIpc(socket, { id: request.id, error: error.message }),
      );
  });
});

async function listen() {
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(path, () => {
      listener.removeListener("error", reject);
      resolve();
    });
  });
}
try {
  await listen();
} catch (error) {
  if (error.code !== "EADDRINUSE") throw error;
  const previous = await connectIpc(path).catch((error) => {
    if (!["ECONNREFUSED", "ENOENT"].includes(error.code)) throw error;
  });
  if (previous) {
    previous.close();
    service.close();
    process.exit(0);
  }
  await unlink(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await listen();
}
await chmod(path, 0o600);
started(service.connect());

async function shutdown() {
  service.close();
  for (const socket of clients) socket.end();
  await new Promise((resolve) => listener.close(resolve));
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

import { setTimeout as delay } from "node:timers/promises";
import { findCli } from "../cli-installation.mjs";
import { connectIpc, privateDirectory, workerLocation } from "./worker-ipc.mjs";
import { launchAgyWorker } from "./worker-launcher.mjs";
import { agyCapabilities } from "../../../../shared/backend-capabilities.mjs";

export function createAgyWorkerAdapter({
  backend: initialBackend,
  config,
  version,
  send,
  broadcast,
}) {
  let backend = initialBackend;
  const location = workerLocation(backend.stateDir);
  let connection;
  let connecting;
  let reconnect;
  let closed = false;
  let stopping = false;
  let state = { method: "lan/state", params: { ready: false, questions: [] } };

  function publish(snapshot) {
    state = snapshot;
    broadcast(state);
  }
  let stateRequest;
  let stateDirty = false;
  function updateState() {
    stateDirty = true;
    if (stateRequest) return;
    const current = connection;
    if (!current) return;
    stateRequest = current
      .call("state")
      .then((snapshot) => {
        if (connection === current) publish(snapshot);
      })
      .catch(() => {})
      .finally(() => {
        stateRequest = undefined;
        if (stateDirty && connection === current) updateState();
      });
    stateDirty = false;
  }

  async function open() {
    await privateDirectory(location.directory);
    const event = (message) => {
      broadcast(message);
      if (
        message.id !== undefined ||
        message.method === "turn/started" ||
        message.method === "turn/completed" ||
        message.method === "serverRequest/resolved" ||
        (message.method === "item/completed" &&
          message.params?.item?.delegation) ||
        message.method === "lan/compaction" ||
        message.method === "lan/files/undone"
      )
        updateState();
    };
    const tryConnect = () =>
      connectIpc(location.socket, event).catch((error) => {
        if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
        return null;
      });
    let peer = await tryConnect();
    if (!peer) {
      await launchAgyWorker(
        { ...backend, executable: await findCli("agy") },
        config,
        version,
        location,
      );
      for (let attempt = 0; !closed && attempt < 120 && !peer; attempt++) {
        await delay(50);
        peer = await tryConnect();
      }
    }
    if (!peer) throw new Error("agy 执行服务启动超时");
    if (closed) return peer.close();
    connection = peer;
    peer.socket.once("close", () => {
      if (connection !== peer) return;
      connection = undefined;
      publish({
        ...state,
        params: {
          ...state.params,
          ready: false,
          error: "正在连接 agy 执行服务",
        },
      });
      if (!closed && !stopping) {
        reconnect = setTimeout(() => connect().catch(() => {}), 1200);
        reconnect.unref();
      }
    });
    try {
      const snapshot = await peer.call("state");
      if (connection === peer) publish(snapshot);
    } catch (error) {
      peer.close();
      throw error;
    }
  }
  function connect() {
    if (connecting) return connecting;
    connecting = open().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }
  return {
    capabilities: agyCapabilities,
    workspaceOwner: "bridge",
    get ready() {
      return state.params.ready;
    },
    state: () => state,
    connect,
    async configure(next) {
      backend = {
        ...backend,
        delegates: next.delegates,
        hiddenModels: next.hiddenModels,
      };
      if (connection) {
        const snapshot = await connection.call("configure", { backend });
        publish(snapshot);
      }
    },
    async receive(client, message) {
      try {
        if (!connection)
          throw new Error(state.params.error || "agy 执行服务尚未就绪");
        const packet = await connection.call("rpc", message);
        if (message.method) send(client, { id: message.id, result: packet });
      } catch (error) {
        if (message.method)
          send(client, {
            id: message.id,
            error: { code: -32000, message: error.message },
          });
        else throw error;
      }
    },
    releaseClient() {},
    releaseUnusedThreads() {},
    async shutdown() {
      if (!connection) return;
      stopping = true;
      try {
        const disconnected = new Promise((resolve) =>
          connection.socket.once("close", resolve),
        );
        await connection.call("shutdown");
        await disconnected;
      } catch (error) {
        stopping = false;
        throw error;
      }
    },
    close() {
      closed = true;
      clearTimeout(reconnect);
      connection?.close();
    },
  };
}

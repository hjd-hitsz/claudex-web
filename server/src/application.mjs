import { hasBackendWork } from "../../shared/backend-activity.mjs";
import { createServiceMaintenance } from "./service-maintenance.mjs";
import { createTranslationService } from "./translation-service.mjs";
import https from "node:https";
import { WebSocketServer } from "ws";
import { createHttpHandler } from "./http/router.mjs";
import { createBusinessHttpHandler } from "./http/business.mjs";
import { createBackendManager } from "./backends/manager.mjs";
import { createConversationManager } from "./conversation-manager/manager.mjs";
import { sendRpcText } from "./rpc-transport.mjs";
import {
  createP2pService,
  createP2pManagementHandler,
} from "./p2p/service.mjs";
import { createPeerClient } from "./p2p-peer.mjs";

export function createWebApplication({
  config,
  tls,
  authentication,
  version,
  runP2pTunnel,
}) {
  let requestsInFlight = 0;
  let closing = false;
  const conversations = createConversationManager({
    configDir: config.configDir,
  });
  const maintenance = createServiceMaintenance({
    config,
    version,
    isBusy: () =>
      !bridge.maintenanceState().params.ready ||
      requestsInFlight > 0 ||
      hasBackendWork(bridge.state().params),
  });
  const translation = createTranslationService(config);
  const clients = new WebSocketServer({ noServer: true });
  const monitors = new WebSocketServer({ noServer: true });
  const peers = new Set();
  function canSend(client) {
    return (
      !closing &&
      ((!client.authLinkId && !client.authSessionId) ||
        authentication.valid(
          client.authSessionId,
          client.authLinkId,
          client.authLocal,
        ))
    );
  }
  function sendText(client, text) {
    if (client.authLinkId) client.send(text);
    else sendRpcText(client, text);
  }
  function send(client, message) {
    if (canSend(client)) sendText(client, JSON.stringify(message));
  }
  function broadcast(message) {
    conversations.onNotification(message);
    let text;
    for (const group of [clients.clients, peers])
      for (const client of group)
        if (canSend(client))
          sendText(client, (text ??= JSON.stringify(message)));
    if (
      monitors.clients.size &&
      [
        "lan/state",
        "lan/compaction",
        "turn/started",
        "turn/completed",
      ].includes(message.method)
    ) {
      const state = JSON.stringify(bridge.maintenanceState());
      for (const monitor of monitors.clients)
        if (canSend(monitor)) sendText(monitor, state);
    }
  }
  const bridge = createBackendManager({
    config,
    version,
    send,
    broadcast,
    conversations,
  });
  const { state, maintenanceState, releaseUnusedThreads } = bridge;
  const handleBusiness = createBusinessHttpHandler({
    translation,
    maintenance,
  });
  const p2p = createP2pService({
    configDirectory: config.configDir,
    assetsDirectory: config.staticDir,
    runTunnel: runP2pTunnel,
    revokeLink: authentication.revokeLink,
    connectPeer(channel, linkId) {
      const peer = createPeerClient(channel, handleBusiness, {
        authentication,
        linkId,
        onAuthenticated(client) {
          peers.add(client);
          send(client, state());
        },
        onLogout(client) {
          peers.delete(client);
          bridge.releaseClient(client);
          releaseUnusedThreads();
        },
      });
      peer.once("close", () => peers.delete(peer));
      connectClient(peer);
      return peer.detach;
    },
  });
  const server = https.createServer(
    tls,
    createHttpHandler({
      config,
      handleBusiness,
      handleP2p: createP2pManagementHandler(p2p),
      tls,
      authentication,
      version,
      isReady: () => bridge.ready,
    }),
  );
  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url, "https://localhost").pathname;
    if (path === "/maintenance" && authentication.maintenance(request)) {
      monitors.handleUpgrade(request, socket, head, (monitor) => {
        monitor.on("error", () => {});
        monitor.on("message", () => monitor.close(1008, "只读维护连接"));
        send(monitor, maintenanceState());
      });
      return;
    }
    if (path !== "/rpc") {
      socket.destroy();
      return;
    }
    const id = authentication.sessionId(request);
    const local = authentication.isDirectLocalRequest(request);
    if (
      !authentication.sameOrigin(request) ||
      !authentication.valid(id, undefined, local)
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    clients.handleUpgrade(request, socket, head, (client) => {
      authentication.attach(client, id, undefined, local);
      clients.emit("connection", client);
    });
  });

  clients.on("connection", (client) => {
    client.alive = true;
    client.on("pong", () => {
      client.alive = true;
    });
    client.on("error", (error) =>
      console.error("Browser connection:", error.message),
    );
    connectClient(client);
  });

  function connectClient(client) {
    client.on("close", () => {
      bridge.releaseClient(client);
      releaseUnusedThreads();
    });
    if (!client.authLinkId) send(client, state());

    client.on("message", (bytes) => {
      if (
        !authentication.valid(
          client.authSessionId,
          client.authLinkId,
          client.authLocal,
        )
      )
        return;
      let message;
      try {
        message = JSON.parse(bytes.toString());
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message))
        return;
      if (maintenance.switching) {
        send(client, {
          id: message.id,
          error: {
            code: -32000,
            message: "服务正在更新或重启，请等待连接恢复",
          },
        });
        return;
      }
      requestsInFlight++;
      receive(client, message)
        .finally(() => {
          requestsInFlight--;
        })
        .catch((error) =>
          send(client, {
            id: message.id,
            error: { code: -32000, message: error.message },
          }),
        );
    });
  }
  async function receive(client, message) {
    if (message.method !== "lan/conversations/activity")
      return bridge.receive(client, message);
    const result = await conversations.listActivity(
      () => state().params.activeTurns,
    );
    send(client, { id: message.id, result });
  }
  const heartbeat = setInterval(() => {
    for (const client of clients.clients) {
      if (!client.alive) client.terminate();
      else {
        client.alive = false;
        client.ping();
      }
    }
    releaseUnusedThreads();
  }, 30000);
  heartbeat.unref();

  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  return {
    server,
    async start() {
      await conversations.start();
      maintenance.initialize();
      await translation.initialize();
      await p2p.start();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await bridge.connect();
    },
    async close() {
      closing = true;
      clearInterval(heartbeat);
      maintenance.close();
      await p2p.close();
      await translation.close();
      const closingConversations = conversations.close();
      try {
        await bridge.close();
      } finally {
        await closingConversations;
      }
      for (const client of [...clients.clients, ...monitors.clients])
        client.terminate();
      clients.close();
      monitors.close();
      if (server.listening)
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      authentication.close();
    },
  };
}

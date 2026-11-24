import { createP2pWire } from "../../../shared/p2p-wire.mjs";
import { activateP2pWorker, connectP2pHttp } from "./p2p-http.js";
import { connectP2pPeer } from "./p2p-rtc.js";

const disconnectDelay = 15000;
const interrupted = "P2P 直连已中断。";

export function createP2pSocket(token, onProgress) {
  const lifetime = new AbortController();
  let peer, channel, wire, http, disconnectTimer;
  let authRequest;
  const socket = {
    readyState: 0,
    send(text) {
      if (socket.readyState !== 1) throw new Error("P2P 连接尚未就绪。");
      wire.send({ type: "rpc", text }).catch(() => finish(1006, interrupted));
    },
    requestAuth(action, fields) {
      if (socket.readyState !== 1 || authRequest)
        return Promise.reject(new Error("当前连接暂时无法登录，请稍后重试。"));
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => finish(1006, "等待登录响应超时，请重试。"),
          20000,
        );
        authRequest = { resolve, reject, timeout, action };
        wire
          .send({ type: "auth", action, ...fields })
          .catch(() => finish(1006, interrupted));
      });
    },
    close() {
      finish(1000, "P2P 连接已断开。");
    },
  };
  function leavePage() {
    socket.close();
  }

  function finish(code, reason) {
    if (socket.readyState === 3) return;
    socket.readyState = 3;
    window.removeEventListener("pagehide", leavePage);
    clearTimeout(disconnectTimer);
    if (authRequest) {
      clearTimeout(authRequest.timeout);
      authRequest.reject(new Error(reason));
      authRequest = undefined;
    }
    lifetime.abort();
    http?.close();
    wire?.close();
    channel?.close();
    peer?.close();
    socket.onclose?.({ code, reason });
  }

  function receive(message, bytes) {
    if (message.type === "auth-result" && authRequest) {
      const { resolve, reject, timeout, action } = authRequest;
      authRequest = undefined;
      clearTimeout(timeout);
      if (message.error)
        reject(
          Object.assign(new Error(message.error), { status: message.status }),
        );
      else {
        if (action === "logout") http.clear("登录已结束，请重新登录。");
        resolve(message);
      }
    } else if (message.type === "rpc" && typeof message.text === "string") {
      socket.onmessage?.({ data: message.text });
    } else http?.receive(message, bytes);
  }

  function checkConnection() {
    if (socket.readyState !== 1) return;
    const state = peer.connectionState;
    if (state === "failed" || state === "closed") finish(1006, interrupted);
    else if (state === "disconnected") {
      disconnectTimer ??= setTimeout(() => {
        disconnectTimer = undefined;
        if (peer.connectionState === "disconnected") finish(1006, interrupted);
      }, disconnectDelay);
    } else {
      clearTimeout(disconnectTimer);
      disconnectTimer = undefined;
    }
  }

  async function connect() {
    if (!globalThis.RTCPeerConnection)
      throw new Error("当前浏览器不支持 WebRTC 直连。");
    const serviceWorker = await activateP2pWorker(
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(12000)]),
    ).catch(() => {
      throw new Error("P2P 网页加载失败，请重试连接。");
    });
    ({ peer, channel } = await connectP2pPeer(
      token,
      lifetime.signal,
      onProgress,
    ));
    if (lifetime.signal.aborted) {
      peer.close();
      return;
    }
    wire = createP2pWire({
      sendFrame: (frame) => channel.send(frame),
      bufferedAmount: () => channel.bufferedAmount,
      receive,
      close: () => finish(1006, interrupted),
    });
    channel.onmessage = ({ data }) => wire.frame(data);
    channel.onclose = channel.onerror = () => finish(1006, interrupted);
    peer.onconnectionstatechange = checkConnection;
    http = connectP2pHttp(serviceWorker, wire.send);
    socket.readyState = 1;
    checkConnection();
    if (socket.readyState === 1) socket.onopen?.();
  }

  window.addEventListener("pagehide", leavePage);
  queueMicrotask(() =>
    connect().catch((error) => finish(error.closeCode || 1006, error.message)),
  );
  return socket;
}

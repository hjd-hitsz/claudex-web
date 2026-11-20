import { createP2pWire } from "../../../shared/p2p-wire.mjs";
import { activateP2pWorker, connectP2pHttp } from "./p2p-http.js";
import { setupP2pPeer } from "./p2p-rtc.js";

const disconnectDelay = 3500;
const joinTimeout = 35000;
const interrupted = "P2P 连接中断，正在重新连接电脑。";
const unreachable =
  "当前网络无法与电脑建立 P2P 直连。请确认电脑在线，或切换网络后重试。";

export function createP2pSocket(token) {
  const lifetime = new AbortController();
  let peer, channel, wire, http, disconnectTimer;
  const socket = {
    readyState: 0,
    send(text) {
      if (socket.readyState !== 1) throw new Error("P2P 连接尚未就绪。");
      wire.send({ type: "rpc", text }).catch(() => finish(1006, interrupted));
    },
    close() {
      finish(1000, "P2P 连接已断开。");
    },
  };
  const timer = setTimeout(() => finish(1006, unreachable), joinTimeout);

  function leavePage() {
    socket.close();
  }

  function finish(code, reason) {
    if (socket.readyState === 3) return;
    socket.readyState = 3;
    window.removeEventListener("pagehide", leavePage);
    clearTimeout(timer);
    clearTimeout(disconnectTimer);
    lifetime.abort();
    http?.close();
    wire?.close();
    channel?.close();
    peer?.close();
    socket.onclose?.({ code, reason });
  }

  function receive(message, bytes) {
    if (message.type === "rpc" && typeof message.text === "string") {
      socket.onmessage?.({ data: message.text });
    } else http?.receive(message, bytes);
  }

  function checkConnection() {
    const state = peer.iceConnectionState;
    if (state === "failed") finish(1006, unreachable);
    else if (state === "disconnected") {
      disconnectTimer ??= setTimeout(
        () => finish(1006, interrupted),
        disconnectDelay,
      );
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
      throw new Error("无法启动 P2P 网页，请重新打开链接后再试。");
    });
    lifetime.signal.throwIfAborted();
    peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    channel = peer.createDataChannel("claudex", { ordered: true });
    channel.binaryType = "arraybuffer";
    wire = createP2pWire({
      sendFrame: (frame) => channel.send(frame),
      bufferedAmount: () => channel.bufferedAmount,
      receive,
      close: () => finish(1006, interrupted),
    });
    channel.onopen = () => {
      if (socket.readyState !== 0) return;
      clearTimeout(timer);
      socket.readyState = 1;
      http = connectP2pHttp(serviceWorker, wire.send);
      socket.onopen?.();
    };
    channel.onmessage = ({ data }) => wire.frame(data);
    channel.onclose = channel.onerror = () => finish(1006, interrupted);
    peer.oniceconnectionstatechange = checkConnection;
    await setupP2pPeer(peer, token, lifetime.signal);
  }

  window.addEventListener("pagehide", leavePage);
  queueMicrotask(() =>
    connect().catch((error) =>
      finish(
        error.closeCode || 1006,
        error instanceof TypeError
          ? "无法访问 P2P 信令入口，请检查网络后重试。"
          : error.message,
      ),
    ),
  );
  return socket;
}

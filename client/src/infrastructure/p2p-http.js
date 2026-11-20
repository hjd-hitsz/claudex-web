import { p2pViewId } from "./p2p-access.js";

const workerPath = "/p2p-sw.js";
const maximumRequests = 16;

export async function activateP2pWorker(signal) {
  const serviceWorker = navigator.serviceWorker;
  if (!serviceWorker) throw new Error("当前浏览器环境无法加载 P2P 网页。");
  await serviceWorker.register(workerPath);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      serviceWorker.removeEventListener("controllerchange", check);
      signal.removeEventListener("abort", aborted);
    };
    const check = () => {
      const url = serviceWorker.controller?.scriptURL;
      if (url && new URL(url).pathname === workerPath) {
        cleanup();
        resolve(serviceWorker);
      }
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    serviceWorker.addEventListener("controllerchange", check);
    signal.addEventListener("abort", aborted, { once: true });
    check();
  });
}

export function connectP2pHttp(serviceWorker, send) {
  let nextId = 1;
  const pending = new Map();

  function finish(id, message) {
    const port = pending.get(id);
    if (!port) return;
    pending.delete(id);
    if (message) port.postMessage(message);
    port.close();
  }

  function onRequest(event) {
    const { data, source } = event;
    const [port] = event.ports;
    if (source !== serviceWorker.controller || !port) return;
    if (data?.type === "claudex-p2p-find-view") {
      port.postMessage(data.id === p2pViewId());
      port.close();
      return;
    }
    if (data?.type !== "claudex-p2p-http") return;
    if (pending.size >= maximumRequests) {
      port.postMessage({
        type: "error",
        message: "待处理请求过多，请稍后重试。",
      });
      port.close();
      return;
    }
    const id = nextId++;
    pending.set(id, port);
    function dispatch(message, bytes) {
      send(message, bytes).catch(() =>
        finish(id, { type: "error", message: "请求发送失败，请重试。" }),
      );
    }
    port.onmessage = ({ data: message }) => {
      if (message === "pull") dispatch({ type: "pull", id });
      if (message === "cancel") {
        finish(id);
        // 客户端已放弃读取，此时传输也可能已断开。
        send({ type: "cancel", id }).catch(() => {});
      }
    };
    const { url, method, headers, body } = data;
    dispatch(
      { type: "request", id, url, method, headers },
      body ? new Uint8Array(body) : undefined,
    );
  }
  serviceWorker.addEventListener("message", onRequest);

  return {
    receive(message, bytes) {
      const port = pending.get(message.id);
      if (!port) return;
      if (message.type === "end" || message.type === "error") {
        finish(message.id, message);
      } else if (message.type === "data" && bytes) {
        port.postMessage({ type: "data", bytes }, [bytes.buffer]);
      } else if (message.type === "response") port.postMessage(message);
    },
    close() {
      serviceWorker.removeEventListener("message", onRequest);
      for (const id of pending.keys())
        finish(id, { type: "error", message: "P2P 连接已中断，请重试。" });
    },
  };
}

// Each operation holds its own app-server subscription through resume and submission.
export async function withCodex(url, operation) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  function fail(error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error)
      request.reject(
        Object.assign(new Error(message.error.message), { rpcRejected: true }),
      );
    else request.resolve(message.result);
  });
  socket.addEventListener("close", () => fail(new Error("Codex 连接已关闭")));
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      deadline.throwIfAborted();
      if (socket.readyState !== WebSocket.OPEN)
        throw new Error("Codex 连接已关闭");
      socket.send(JSON.stringify({ id: ++id, method, params }));
      pending.set(id, { resolve, reject });
    });
  const deadline = AbortSignal.timeout(30000);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("连接 Codex app-server 失败")),
        { once: true },
      );
      deadline.addEventListener("abort", () => reject(deadline.reason), {
        once: true,
      });
    });
    const expire = () => {
      fail(deadline.reason);
      socket.close();
    };
    deadline.addEventListener("abort", expire, { once: true });
    try {
      await call("initialize", {
        clientInfo: { name: "codex_background_terminal", version: "1" },
        capabilities: { experimentalApi: true },
      });
      socket.send(JSON.stringify({ method: "initialized" }));
      return await operation(call);
    } finally {
      deadline.removeEventListener("abort", expire);
    }
  } finally {
    socket.close();
  }
}

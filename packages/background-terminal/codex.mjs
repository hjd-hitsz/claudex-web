export async function connectCodex(url, { event, disconnected } = {}) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method) {
      event?.(message);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    if (message.error)
      request.reject(
        Object.assign(new Error(message.error.message), { rpcRejected: true }),
      );
    else request.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values())
      request.reject(new Error("Codex 连接已关闭"));
    disconnected?.();
  });
  async function call(method, params, timeout = 30000) {
    if (socket.readyState !== WebSocket.OPEN)
      throw new Error("Codex 连接已关闭");
    const requestId = ++id;
    const reply = Promise.withResolvers();
    const timer = setTimeout(
      () => reply.reject(new Error("Codex 请求超时：" + method)),
      timeout,
    );
    pending.set(requestId, reply);
    try {
      socket.send(JSON.stringify({ id: requestId, method, params }));
      return await reply.promise;
    } finally {
      clearTimeout(timer);
      pending.delete(requestId);
    }
  }
  const deadline = Date.now() + 30000;
  try {
    const opened = Promise.withResolvers();
    const timer = setTimeout(
      () => opened.reject(new Error("连接 Codex app-server 超时")),
      30000,
    );
    socket.addEventListener("open", opened.resolve, { once: true });
    socket.addEventListener(
      "error",
      () => opened.reject(new Error("连接 Codex app-server 失败")),
      { once: true },
    );
    try {
      await opened.promise;
    } finally {
      clearTimeout(timer);
    }
    await call(
      "initialize",
      {
        clientInfo: { name: "codex_background_terminal", version: "1" },
        capabilities: { experimentalApi: true },
      },
      Math.max(0, deadline - Date.now()),
    );
    socket.send(JSON.stringify({ method: "initialized" }));
    return { call, close: () => socket.close() };
  } catch (error) {
    socket.close();
    throw error;
  }
}

export async function withCodex(url, operation, lifecycle) {
  const deadline = Date.now() + 30000;
  const connection = await connectCodex(url, lifecycle);
  try {
    return await operation((method, params) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Codex 操作超时：" + method);
      return connection.call(method, params, remaining);
    });
  } finally {
    connection.close();
  }
}

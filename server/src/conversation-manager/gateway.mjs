import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection, createServer as createLease } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureConversationDirectory } from "./store.mjs";

function json(response, status, data) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}

async function ensureVacant(socketPath) {
  const stat = await lstat(socketPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!stat) return;
  if (!stat.isSocket() || stat.uid !== process.getuid?.())
    throw new Error("会话管理器地址已有其他文件");
  await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("当前配置目录已有会话管理器运行"));
    });
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
  await unlink(socketPath);
}

function listen(server, path) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  if (!server.listening) return;
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export function createConversationGateway(configDir, getKey, invoke) {
  const directory = join(tmpdir(), `claudex-chat-${process.getuid?.()}`);
  let socketPath;
  const lease = createLease((socket) => socket.destroy());
  const tokenFor = (runtimeId, secret = getKey()) =>
    createHmac("sha256", secret).update(runtimeId).digest("base64url");
  const limit = 512 * 1024;
  const server = createServer(async (request, response) => {
    const runtimeId = request.headers["x-claudex-runtime"];
    const supplied = Buffer.from(request.headers.authorization || "");
    if (request.method !== "POST" || request.url !== "/conversation-tool")
      return json(response, 404, { error: "未知会话管理端点" });
    if (typeof runtimeId !== "string" || !/^[a-f0-9]{32}$/.test(runtimeId))
      return json(response, 403, { error: "会话工具鉴权失败" });
    const secret = getKey();
    if (!secret) return json(response, 503, { error: "会话管理器正在启动" });
    const expected = Buffer.from(`Bearer ${tokenFor(runtimeId, secret)}`);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return json(response, 403, { error: "会话工具鉴权失败" });
    try {
      if (Number(request.headers["content-length"]) > limit)
        return json(response, 413, { error: "会话工具请求超出大小限制" });
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > limit) throw new Error("会话工具请求超出大小限制");
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const { threadId, name, args, callId } = payload;
      json(response, 200, {
        result: await invoke(runtimeId, { threadId, callId }, name, args),
      });
    } catch (error) {
      json(response, 400, { error: error.message });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return {
    endpoint(runtimeId) {
      return { socketPath, runtimeId, token: tokenFor(runtimeId) };
    },
    async start() {
      await ensureConversationDirectory(directory);
      const canonical = await realpath(configDir);
      const key = createHash("sha256").update(canonical).digest("hex");
      socketPath = join(directory, key.slice(0, 24) + ".sock");
      // Linux releases an abstract socket lease on process exit, including SIGKILL.
      try {
        await listen(lease, `\0claudex-chat-${process.getuid?.()}-${key}`);
      } catch (error) {
        if (error.code !== "EADDRINUSE") throw error;
        throw new Error("当前配置目录已有会话管理器运行", { cause: error });
      }
      await ensureVacant(socketPath);
      await listen(server, socketPath);
      await chmod(socketPath, 0o600);
    },
    async close() {
      try {
        const closing = close(server);
        server.closeAllConnections();
        await closing;
      } finally {
        await close(lease);
      }
    },
  };
}

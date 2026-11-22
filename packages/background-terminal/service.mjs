import http from "node:http";
import { createHash } from "node:crypto";
import {
  mkdir,
  chmod,
  rm,
  readFile,
  writeFile,
  rename,
} from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { once } from "node:events";
import { createBackgroundJobs } from "./background-jobs.mjs";
import { privateDirectory, socketPath } from "./client.mjs";
import { createDelivery } from "./delivery.mjs";
import { createNativeWatches } from "./native-watches.mjs";
import { withCodex } from "./codex.mjs";

export async function serve(location, upstream) {
  const url = new URL(upstream);
  if (
    url.protocol !== "ws:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("任务服务须与 Codex 工作区同机，请指定回环 WebSocket 地址");
  await mkdir(location, { recursive: true, mode: 0o700 });
  const directory = await privateDirectory(location);
  const path = socketPath(directory);
  // The kernel releases the abstract lock on exit. Only its owner removes a stale filesystem socket.
  const lock = net.createServer((socket) => socket.destroy());
  const key = createHash("sha256").update(directory).digest("hex");
  lock.listen("\0claudex-background-lock-" + key);
  await once(lock, "listening");
  let jobs,
    nativeWatches,
    closing = false;
  const server = http.createServer(async (req, res) => {
    function reply(status, data) {
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(data));
    }
    if (req.method !== "POST" || req.headers.origin)
      return reply(403, { error: "访问被拒绝" });
    if (!jobs || closing) return reply(503, { error: "任务服务尚未就绪" });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error("请求过大");
        chunks.push(chunk);
      }
      const { method, params } = JSON.parse(Buffer.concat(chunks));
      if (params?.expectedUpstream && params.expectedUpstream !== url.href)
        throw new Error("任务服务绑定的 Codex 后端地址与客户端不同");
      if (method === "health")
        return reply(200, {
          upstream: url.href,
          nativeWatch: true,
          pid: process.pid,
        });
      if (method === "tool") return reply(200, await jobs.tool(params));
      if (method === "watchNative")
        return reply(200, await nativeWatches.watch(params));
      throw new Error("未知操作");
    } catch (error) {
      reply(400, { error: error.message });
    }
  });
  try {
    const binding = join(directory, "upstream");
    const previous = await readFile(binding, "utf8").catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    if (previous && previous !== url.href)
      throw new Error("此状态目录属于其他 Codex app-server");
    await writeFile(binding + ".tmp", url.href, { mode: 0o600 });
    await rename(binding + ".tmp", binding);
    await rm(path, { force: true });
    jobs = await createBackgroundJobs({
      directory,
      terminateNative: ({ threadId, native }) =>
        withCodex(url, (call) =>
          call("thread/backgroundTerminals/terminate", {
            threadId,
            processId: native.processId,
          }),
        ),
      readThread: (id) =>
        withCodex(url, async (call) => {
          const { thread } = await call("thread/read", {
            threadId: id,
            includeTurns: false,
          });
          if (thread.ephemeral || thread.path?.includes("/archived_sessions/"))
            throw new Error("后台终端需要已持久化的活动对话");
          const session = await call("thread/resume", {
            threadId: id,
            excludeTurns: true,
          });
          if (session.sandbox?.type !== "dangerFullAccess")
            throw new Error("后台终端需要对话已授权完全访问");
          return session.thread;
        }),
    });
    nativeWatches = createNativeWatches(url, jobs);
    server.listen(path);
    await once(server, "listening");
    await chmod(path, 0o600);
    const stopDelivery = createDelivery(directory, url, jobs);
    const stop = async () => {
      if (closing) return;
      closing = true;
      server.close();
      await stopDelivery();
      await nativeWatches.close();
      await jobs.close();
      lock.close();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    server.close();
    lock.close();
    throw error;
  }
}

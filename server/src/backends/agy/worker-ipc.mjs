import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { MAX_RPC_MESSAGE_BYTES } from "../../../../shared/rpc-limits.mjs";

export function workerLocation(stateDir) {
  const uid = process.getuid();
  const key = createHash("sha256")
    .update(resolve(stateDir))
    .digest("hex")
    .slice(0, 20);
  const directory = join(
    process.env.XDG_RUNTIME_DIR || tmpdir(),
    `claudex-agy-${uid}`,
  );
  return {
    directory,
    socket: join(directory, key + ".sock"),
    unit: "claudex-web-agy-" + key,
  };
}

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077)
    throw new Error("agy IPC 目录须由当前用户持有且权限为 0700");
}

export function receiveIpc(socket, receive) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_RPC_MESSAGE_BYTES) {
      socket.destroy(new Error("agy IPC 消息超过大小限制"));
      return;
    }
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        socket.destroy(new Error("agy IPC 消息无效"));
        return;
      }
      receive(message);
    }
  });
}
export function sendIpc(socket, packet) {
  if (!socket.destroyed) socket.write(JSON.stringify(packet) + "\n");
}

export async function connectIpc(path, event) {
  const info = await lstat(path);
  if (!info.isSocket() || info.uid !== process.getuid() || info.mode & 0o077)
    throw new Error("agy IPC socket 须由当前用户持有且权限为 0600");
  const socket = createConnection(path);
  const pending = new Map();
  let nextId = 0;
  receiveIpc(socket, (packet) => {
    if (packet.event) return event?.(packet.event);
    const call = pending.get(packet.id);
    if (!call) return;
    pending.delete(packet.id);
    clearTimeout(call.timer);
    if (packet.error) call.reject(new Error(packet.error));
    else call.resolve(packet.result);
  });
  socket.on("error", () => {});
  socket.once("close", () => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("agy 执行服务连接已断开"));
    }
    pending.clear();
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    call(method, params, timeout = 30000) {
      return new Promise((resolve, reject) => {
        if (socket.destroyed)
          return reject(new Error("agy 执行服务连接已断开"));
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("agy 执行服务请求超时"));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        sendIpc(socket, { id, method, params });
      });
    },
    close: () => socket.destroy(),
  };
}

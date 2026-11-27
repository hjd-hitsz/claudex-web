import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { networkProxyEnvironment } from "../network-proxy.mjs";
import { secretaryName } from "./native-agent.mjs";

export function createAcpClient({
  executable,
  cwd,
  agent = secretaryName,
  proxy,
  onUpdate,
  onRequest,
  onExit,
}) {
  const child = spawn(
    executable,
    [
      "acp",
      "--agent=" + agent,
      "--add-dir=" + cwd,
      "--include-default-customizations=false",
      "--sandbox",
      ...(agent === secretaryName ? ["--dangerously-skip-permissions"] : []),
    ],
    {
      cwd,
      env: { ...process.env, ...networkProxyEnvironment(proxy) },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const pending = new Map();
  let sequence = 0;
  let errorOutput = "";
  let closed = false;
  const exited = new Promise((resolve) => child.once("close", resolve));

  function send(packet) {
    if (closed || child.stdin.destroyed) throw new Error("agy ACP 连接已关闭");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...packet }) + "\n");
  }
  function fail(error) {
    if (closed) return;
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
    onExit?.(error);
  }
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    errorOutput = (errorOutput + chunk).slice(-4096);
  });
  child.on("close", (code, signal) => {
    fail(
      new Error(
        "agy ACP 已退出（" +
          (signal || code) +
          "）" +
          (errorOutput.trim() ? "：" + errorOutput.trim() : ""),
      ),
    );
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let packet;
    try {
      packet = JSON.parse(line);
    } catch {
      fail(new Error("agy ACP 返回了无效的 JSON-RPC"));
      child.kill();
      return;
    }
    if (packet.method) {
      if (packet.id === undefined) {
        onUpdate?.(packet.method, packet.params);
        return;
      }
      Promise.resolve()
        .then(() => onRequest(packet.method, packet.params))
        .then(
          (result) => send({ id: packet.id, result }),
          (error) =>
            send({
              id: packet.id,
              error: { code: -32000, message: error.message },
            }),
        )
        .catch(fail);
      return;
    }
    const query = pending.get(packet.id);
    if (!query) return;
    pending.delete(packet.id);
    clearTimeout(query.timer);
    if (packet.error) {
      query.reject(
        Object.assign(new Error(packet.error.message), {
          code: packet.error.code,
          data: packet.error.data,
        }),
      );
    } else query.resolve(packet.result);
  });

  return {
    exited,
    get closed() {
      return closed;
    },
    call(method, params, timeout = 20000) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = timeout
          ? setTimeout(() => {
              pending.delete(id);
              reject(new Error("agy ACP 请求超时：" + method));
            }, timeout)
          : undefined;
        pending.set(id, { resolve, reject, timer });
        try {
          send({ id, method, params });
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    notify(method, params) {
      send({ method, params });
    },
    close() {
      fail(new Error("agy ACP 会话已关闭"));
      child.stdin.end();
      child.kill();
    },
  };
}

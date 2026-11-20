import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { readConfig } from "../server/src/config.mjs";
import { localTlsClient, readTls } from "../server/src/tls.mjs";

async function localControlOptions() {
  const config = readConfig();
  if (config.port === 0) throw new Error("P2P 命令需要固定的 HTTPS 监听端口");
  const token = await readFile(
    join(config.configDir, "auth", "maintenance-token"),
    "utf8",
  ).catch((error) => {
    if (error.code === "ENOENT") throw new Error("请先启动 Claudex Web 服务");
    throw error;
  });
  const { cert } = await readTls(config);
  const hostname = ["::", "::1"].includes(config.host)
    ? "::1"
    : config.host === "localhost"
      ? "localhost"
      : "127.0.0.1";
  return { ...localTlsClient(cert), hostname, port: config.port, token };
}

function send({ token, ...options }, command, input, deadline) {
  const query = command === "status" || command === "list";
  const body = input === undefined ? undefined : JSON.stringify(input);
  const timeout = AbortSignal.timeout(10000);
  return new Promise((resolve, reject) => {
    const connection = request(
      {
        ...options,
        path: query ? "/api/p2p" : `/api/p2p/${command}`,
        method: query ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }),
        },
        signal: deadline ? AbortSignal.any([timeout, deadline]) : timeout,
      },
      async (response) => {
        try {
          const chunks = [];
          for await (const chunk of response) chunks.push(chunk);
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode !== 200)
            throw new Error(result.error || "P2P 操作失败");
          resolve(result);
        } catch (error) {
          reject(error);
        }
      },
    );
    connection.on("error", (error) => {
      reject(
        error.code === "ECONNREFUSED"
          ? new Error(
              "无法连接本机 Claudex Web 服务，请确认 HTTPS 监听包含回环地址",
            )
          : error,
      );
    });
    connection.end(body);
  });
}

async function waitForOnline(options) {
  const signal = AbortSignal.timeout(90000);
  let announced = false;
  try {
    while (true) {
      const status = await send(options, "status", undefined, signal);
      if (status.state === "error")
        throw new Error(status.error || "OpenTunnel 连接失败");
      if (!status.enabled)
        throw new Error("P2P 已关闭，请先执行 claudex-web p2p enable");
      if (status.state === "online") return;
      if (!announced) console.error("正在等待 OpenTunnel 就绪…");
      announced = true;
      await wait(1000, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted)
      throw new Error("等待 OpenTunnel 就绪超时，可稍后重新生成链接");
    throw error;
  }
}

const statusLabels = {
  disabled: "已关闭",
  connecting: "正在连接 OpenTunnel",
  online: "已连接 OpenTunnel",
  error: "连接异常",
};

export async function runP2pCommand([action = "status", ...args]) {
  const commands = ["status", "enable", "disable", "create", "list", "revoke"];
  if (
    !commands.includes(action) ||
    (action === "revoke" && args.length !== 1) ||
    (!["create", "revoke"].includes(action) && args.length)
  )
    throw new Error(
      "用法：claudex-web p2p status|enable|disable|create [名称]|list|revoke <ID>",
    );

  const input =
    action === "create"
      ? { label: args.join(" ") }
      : action === "revoke"
        ? { id: args[0] }
        : undefined;
  const options = await localControlOptions();
  if (action === "create") await waitForOnline(options);
  const result = await send(options, action, input);
  if (action === "create") console.log(result.created.url);
  else if (action === "list") {
    if (!result.links.length) console.log("暂无授权链接");
    for (const { id, label, createdAt, url } of result.links)
      console.log(`${id}\t${label}\t${createdAt}\t${url}`);
  } else if (action === "revoke") console.log(`已撤销 P2P 链接 ${input.id}`);
  else {
    console.log(`P2P ${statusLabels[result.state]}`);
    if (result.error) console.log(result.error);
    if (result.origin) console.log(result.origin);
  }
}

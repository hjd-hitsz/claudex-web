import { execFileSync } from "node:child_process";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { readConfig } from "../server/src/config.mjs";
import { readTls, localTlsClient } from "../server/src/tls.mjs";
import { isCompacting } from "../server/src/compaction.mjs";

const unit = "claudex-web-restart-when-idle.service";
const entry = fileURLToPath(import.meta.url);

export function requestIdleRestart() {
  const environment = [
    "PORT",
    "CLAUDEX_WEB_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "TLS_CERT",
    "TLS_KEY",
  ].flatMap((name) =>
    process.env[name] === undefined
      ? []
      : ["--setenv=" + name + "=" + process.env[name]],
  );
  execFileSync(
    "systemd-run",
    [
      "--user",
      "--no-block",
      "--collect",
      "--unit=" + unit,
      "--property=Type=exec",
      "--working-directory=" + process.cwd(),
      ...environment,
      "--",
      process.execPath,
      entry,
      "--watch",
    ],
    { stdio: "inherit" },
  );
  console.log("已提交网页空闲重启，进度记录在 " + unit + " 的日志。");
}

export async function watchForIdle() {
  const config = readConfig();
  const tls = await readTls(config);
  const localTls = localTlsClient(tls.cert);
  const origin = `https://127.0.0.1:${config.port}`;
  const url = origin.replace("https:", "wss:") + "/maintenance";
  const token = await readFile(
    join(config.configDir, "auth", "maintenance-token"),
    "utf8",
  );
  function health() {
    return new Promise((resolve) => {
      const request = https.get(origin + "/healthz", localTls, (response) => {
        let body = "";
        response.on("data", (bytes) => {
          body += bytes;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      });
      request.setTimeout(5000, () => request.destroy());
      request.on("error", () => resolve(null));
    });
  }
  let timer,
    restarting = false;
  function connect() {
    const socket = new WebSocket(url, {
      ...localTls,
      headers: { Authorization: `Bearer ${token}` },
    });
    let ready = false;
    const turns = new Map(),
      compactions = new Map();
    let lastStatus;
    function check() {
      if (restarting) return;
      const status = `等待空闲：${turns.size} 个任务，${compactions.size} 个上下文整理${ready ? "。" : "，正在连接。"}`;
      if (status !== lastStatus) {
        console.log(status);
        lastStatus = status;
      }
      if (!ready || turns.size || compactions.size) {
        clearTimeout(timer);
        timer = undefined;
        return;
      }
      if (timer) return;
      timer = setTimeout(async () => {
        restarting = true;
        try {
          execFileSync(
            "systemctl",
            ["--user", "restart", "claudex-web.service"],
            { stdio: "inherit" },
          );
          for (let attempt = 0; attempt < 30; attempt++) {
            const status = await health();
            if (status?.ready) {
              console.log(
                `网页服务已重启并通过健康检查，运行版本：${status.version?.displayVersion || "未知"}。`,
              );
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          throw new Error("网页服务已执行重启，健康检查等待超时。");
        } catch (error) {
          console.error(error.message);
          process.exitCode = 1;
        } finally {
          socket.close();
        }
      }, 2000);
    }
    socket.on("message", (bytes) => {
      const { method, params: p = {} } = JSON.parse(bytes);
      if (
        ![
          "lan/state",
          "lan/compaction",
          "turn/started",
          "turn/completed",
        ].includes(method)
      )
        return;
      if (method === "lan/state") {
        ready = p.ready;
        turns.clear();
        for (const [threadId, turnId] of Object.entries(p.activeTurns))
          turns.set(threadId, turnId);
        compactions.clear();
        for (const [id, entry] of Object.entries(p.compactions || {}))
          if (isCompacting(entry)) compactions.set(id, entry);
      }
      if (method === "lan/compaction") {
        if (isCompacting(p.compaction))
          compactions.set(p.threadId, p.compaction);
        else compactions.delete(p.threadId);
      }
      if (method === "turn/started") turns.set(p.threadId, p.turn.id);
      if (method === "turn/completed" && turns.get(p.threadId) === p.turn.id)
        turns.delete(p.threadId);
      check();
    });
    socket.on("error", (error) => console.error(error.message));
    socket.on("close", () => {
      clearTimeout(timer);
      timer = undefined;
      if (!restarting) setTimeout(connect, 2000);
    });
  }
  connect();
}

if (process.argv[1] && resolve(process.argv[1]) === entry) {
  if (process.argv[2] === "--watch") {
    const cgroup = await readFile("/proc/self/cgroup", "utf8");
    if (!cgroup.split("\n").some((line) => line.endsWith("/" + unit)))
      throw new Error("空闲监视进程由 systemd 用户单元启动");
    await watchForIdle();
  } else {
    requestIdleRestart();
  }
}

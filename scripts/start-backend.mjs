import { createBackendConfiguration } from "../server/src/backends/configuration.mjs";
import { spawn } from "node:child_process";
import { readConfig } from "../server/src/config.mjs";

const config = readConfig();
const { backends } = await createBackendConfiguration(config).read();
const backend = backends.find((b) => b.id === "codex" && b.enabled);
if (!backend) throw new Error("Codex 后端未启用");
const url = new URL(backend.url);
if (url.protocol !== "ws:" || url.pathname !== "/" || url.search || url.hash)
  throw new Error(
    "Codex 本机监听地址须使用 ws://主机:端口，且不含路径、查询参数或片段",
  );
const listenUrl = `ws://${url.hostname}:${url.port || 80}`;
const child = spawn(
  backend.executable || "codex",
  [
    ...(backend.args || []),
    "-c",
    "thread_unload_delay_secs=0",
    "app-server",
    "--listen",
    listenUrl,
  ],
  { stdio: "inherit", env: { ...process.env, CODEX_HOME: backend.dataDir } },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));

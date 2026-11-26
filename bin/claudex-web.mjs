#!/usr/bin/env node
// Claudex Web 命令入口，配置与运行时数据独立于 npm 安装目录。
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { readConfig } from "../server/src/config.mjs";
import { readVersion } from "../server/src/version.mjs";

import {
  productDirectories,
  migrateProductConfig,
} from "../server/src/product-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories = productDirectories();
const { configDir } = directories;
const args = process.argv.slice(2);
const command = args.join(" ") || "start";

async function main() {
  if (["--help", "-h", "help"].includes(command)) {
    console.log(`Claudex Web — Codex 与 Claude Code 的浏览器客户端

用法：claudex-web [命令]
  start                      前台启动网页服务（默认命令）
  backend                    前台启动 Codex app-server
  config init                创建用户配置，保留已有配置
  auth setup [名称]          显示指定验证器的绑定二维码
  auth list                  查看验证器名称和绑定状态
  auth revoke <名称>         撤销指定验证器及其登录会话
  auth disable               关闭双重验证并清除全部绑定
  service install            安装并启动 Linux systemd 用户服务
  service status             查看网页与后端服务状态
  service start              启动网页服务及其 Codex 后端
  service stop               停止网页服务
  service restart            重启网页服务
  service restart-when-idle   提交空闲重启，由 systemd 用户单元执行
  p2p status                 查看 P2P 接入状态（默认关闭）
  p2p enable | disable      开启或暂停 P2P 接入
  p2p create [名称]          生成长期授权链接
  p2p list                   查看授权链接及其 ID
  p2p revoke <ID>            撤销授权链接并断开相应连接
  --version                  显示版本与开发构建标识
  version --json             显示完整版本、提交和构建信息

配置目录：${configDir}
可用 CLAUDEX_WEB_CONFIG_DIR 指定配置目录。
安装 npm 包后执行 claudex-web service install 可启用后台访问。`);
    return;
  }
  if (["--version", "-v"].includes(command)) {
    console.log(readVersion().displayVersion);
    return;
  }
  if (command === "version --json") {
    console.log(JSON.stringify(readVersion(), null, 2));
    return;
  }
  if (
    !["auth", "p2p"].includes(args[0]) &&
    ![
      "start",
      "backend",
      "config init",
      "service install",
      "service status",
      "service start",
      "service stop",
      "service restart",
      "service restart-when-idle",
    ].includes(command)
  )
    throw new Error(`未知命令：${command}。使用 claudex-web --help 查看用法。`);
  if (command.startsWith("service ") && process.platform !== "linux")
    throw new Error("后台服务管理需要 Linux 和 systemd 用户服务。");

  await migrateProductConfig(directories);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  if (["config init", "service install"].includes(command)) {
    try {
      await copyFile(
        join(root, ".env.example"),
        join(configDir, ".env"),
        constants.COPYFILE_EXCL,
      );
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  process.env.CLAUDEX_WEB_CONFIG_DIR = configDir;
  process.chdir(configDir);
  try {
    loadEnvFile(join(configDir, ".env"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (args[0] === "p2p") {
    const { runP2pCommand } = await import("./p2p.mjs");
    await runP2pCommand(args.slice(1));
    return;
  }
  if (args[0] === "auth") {
    const { runAuthCommand } = await import("./auth.mjs");
    await runAuthCommand(args.slice(1), readConfig());
    return;
  }
  switch (command) {
    case "config init":
      console.log(`用户配置：${join(configDir, ".env")}`);
      break;
    case "start":
      await import("../server/src/server.mjs");
      break;
    case "backend":
      await import("../scripts/start-backend.mjs");
      break;
    case "service install": {
      const { installServices } =
        await import("../scripts/install-services.mjs");
      await installServices({ configDir, cli: true });
      console.log('开机运行用户服务：loginctl enable-linger "$USER"');
      const config = readConfig();
      console.log(
        `HTTPS 健康检查：https://127.0.0.1:${config.port}/healthz；证书：${config.tlsCert || join(config.configDir, "tls", "certificate.pem")}`,
      );
      break;
    }
    case "service restart-when-idle": {
      const { requestIdleRestart } =
        await import("../scripts/restart-when-idle.mjs");
      requestIdleRestart();
      break;
    }
    default: {
      const action = args[1];
      const units = ["claudex-web.service"];
      if (action === "status")
        units.push("codex-app-server.service", "--no-pager");
      execFileSync("systemctl", ["--user", action, ...units], {
        stdio: "inherit",
      });
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = typeof error.status === "number" ? error.status || 1 : 1;
});

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { taskRequest } from "../../../../packages/background-terminal/client.mjs";
import { supportsBackgroundTerminal } from "../../config.mjs";

export function createBackgroundService(config) {
  const directory =
    config.backgroundTaskDir || join(config.configDir, "background-terminal");
  const upstream = new URL(config.upstreamUrl).href;
  const available = supportsBackgroundTerminal(upstream);
  let checking;
  async function responding() {
    try {
      await taskRequest(directory, "health", { expectedUpstream: upstream });
      return true;
    } catch (error) {
      if (["ENOENT", "ECONNREFUSED"].includes(error.code)) return false;
      throw error;
    }
  }
  async function start() {
    if (!available)
      throw new Error("后台终端 MCP 需要同机 Codex 回环 WebSocket 连接");
    if (await responding()) return directory;
    const unit =
      "claudex-background-" +
      createHash("sha256").update(directory).digest("hex").slice(0, 16);
    const entry = fileURLToPath(
      new URL(
        "../../../../packages/background-terminal/cli.mjs",
        import.meta.url,
      ),
    );
    let launchError;
    try {
      await promisify(execFile)(
        "systemd-run",
        [
          "--user",
          "--collect",
          "--property=Restart=on-failure",
          "--service-type=exec",
          "--unit",
          unit,
          "--",
          process.execPath,
          entry,
          "serve",
          directory,
          upstream,
        ],
        { timeout: 5000 },
      );
    } catch (error) {
      launchError = error;
    }
    // Another bridge using this directory may already be starting the same unit.
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await responding()) return directory;
      await delay(100);
    }
    throw new Error(
      "后台终端服务启动失败：" +
        (launchError?.stderr?.trim() ||
          launchError?.message ||
          unit + ".service"),
    );
  }
  return {
    available,
    directory,
    listening: () => existsSync(join(directory, "service.sock")),
    ensure() {
      checking ??= start().finally(() => {
        checking = null;
      });
      return checking;
    },
  };
}

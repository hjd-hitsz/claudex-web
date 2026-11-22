import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  privateDirectory,
  taskRequest,
} from "../../../../packages/background-terminal/client.mjs";
import { supportsBackgroundTerminal } from "../../config.mjs";
import { spawnDetached } from "../../service-maintenance-process.mjs";

async function runsInWebUserUnit() {
  if (process.platform !== "linux") return false;
  const cgroups = await readFile("/proc/self/cgroup", "utf8").catch(() => "");
  return cgroups
    .split("\n")
    .some(
      (line) =>
        line.includes(`/user@${process.getuid()}.service/`) &&
        line.endsWith("/claudex-web.service"),
    );
}

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
    const entry = fileURLToPath(
      new URL(
        "../../../../packages/background-terminal/cli.mjs",
        import.meta.url,
      ),
    );
    const args = [entry, "serve", directory, upstream];
    const logFile = join(directory, "worker.log");
    let unit;
    let launchError;
    try {
      if (await runsInWebUserUnit()) {
        // Give the worker its own cgroup so a managed web restart leaves it running.
        unit =
          "claudex-background-" +
          createHash("sha256").update(directory).digest("hex").slice(0, 16);
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
            ...args,
          ],
          { timeout: 5000 },
        );
      } else {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await privateDirectory(directory);
        await spawnDetached(process.execPath, args, { logFile });
      }
    } catch (error) {
      launchError = error;
    }
    // The worker's socket lock makes concurrent starts converge on one service.
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await responding()) return directory;
      await delay(100);
    }
    throw new Error(
      "后台终端服务启动失败：" +
        (launchError?.stderr?.trim() ||
          launchError?.message ||
          (unit ? unit + ".service" : `请查看 ${logFile}`)),
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

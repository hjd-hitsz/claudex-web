import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  writeFile,
  rename,
} from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const packageName = "@hjd-hitsz/claudex-web";
export function createServiceMaintenance({
  config,
  version,
  isBusy = () => false,
  run = execute,
  fetchVersion = async () => {
    const response = await fetch(
      `https://registry.npmjs.org/${packageName}/latest`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) throw new Error(`npm 版本查询失败（${response.status}）`);
    return (await response.json()).version;
  },
}) {
  const directory = join(config.configDir, "maintenance");
  const statusFile = join(directory, "status.json");
  let latest = null,
    error = "",
    checkedAt = null,
    checking,
    submitting = false,
    timer,
    switching = false;
  const suffix = "/lib/node_modules/" + packageName;
  const npmInstalled = root.replace(/\/$/, "").endsWith(suffix);
  const prefix = npmInstalled
    ? root.replace(/\/$/, "").slice(0, -suffix.length)
    : null;
  async function check() {
    if (checking) return checking;
    checking = (async () => {
      try {
        const value = await fetchVersion();
        if (!/^\d+\.\d+\.\d+$/.test(value))
          throw new Error("npm 返回了无效的稳定版本");
        latest = value;
        checkedAt = new Date().toISOString();
        error = "";
      } catch (failure) {
        error = failure.message;
      }
    })().finally(() => {
      checking = null;
    });
    return checking;
  }
  async function status() {
    let task = null;
    try {
      task = JSON.parse(await readFile(statusFile, "utf8"));
    } catch (failure) {
      if (failure.code !== "ENOENT") throw failure;
    }
    if (
      ["updating", "restarting"].includes(task?.state) &&
      Date.now() - Date.parse(task.startedAt) > 30000
    ) {
      try {
        await run("systemctl", [
          "--user",
          "is-active",
          "--quiet",
          "claudex-web-maintenance.service",
        ]);
      } catch {
        task = {
          ...task,
          state: "failed",
          error: "维护任务已退出，请查看维护日志并重试",
        };
        await writeFile(statusFile + ".tmp", JSON.stringify(task), {
          mode: 0o600,
        });
        await rename(statusFile + ".tmp", statusFile);
      }
    }
    if (task?.state === "failed") switching = false;
    let managed = false;
    try {
      const { stdout } = await run("systemctl", [
        "--user",
        "show",
        "claudex-web.service",
        "--property=MainPID",
        "--value",
      ]);
      managed = Number(stdout.trim()) === process.pid;
    } catch {
      /* 服务管理能力由当前进程归属决定。 */
    }
    const updateAvailable =
      latest &&
      latest.localeCompare(version.version, undefined, { numeric: true }) > 0;
    return {
      current: version.version,
      latest,
      checkedAt,
      error,
      npmInstalled,
      managed,
      updateAvailable: Boolean(updateAvailable),
      task,
    };
  }
  async function start(action) {
    if (submitting) return status();
    submitting = true;
    try {
      const current = await status();
      if (["updating", "restarting"].includes(current.task?.state))
        return current;
      if (isBusy()) throw new Error("任务仍在运行，请结束后重试。");
      if (!current.managed)
        throw new Error(
          "请通过 claudex-web service install 安装并启动 systemd 用户服务后重试",
        );
      if (action === "update") {
        await check();
        if (error) throw new Error(error);
        if (!npmInstalled)
          throw new Error(
            "网页更新适用于 npm 全局安装。源码部署请先更新源码并构建，再使用重启服务",
          );
        if (!(await status()).updateAvailable)
          throw new Error("当前已是最新版本");
        await access(resolve(root, ".."), constants.W_OK);
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await copyFile(
        new URL("./service-maintenance-worker.mjs", import.meta.url),
        join(directory, "worker.mjs"),
      );
      const task = {
        action,
        state: action === "update" ? "updating" : "restarting",
        target: action === "update" ? latest : version.version,
        startedAt: new Date().toISOString(),
      };
      const job = {
        action,
        root: resolve(root),
        prefix,
        packageName,
        task,
        statusFile,
        port: config.port,
        cert: config.tlsCert || join(config.configDir, "tls/certificate.pem"),
        // 独立用户单元使用管理器的环境，npm 须沿用网页服务的安装与网络环境。
        environment: Object.fromEntries(
          Object.entries({
            ...process.env,
            PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ""}`,
          }).filter(
            ([key]) =>
              [
                "PATH",
                "HOME",
                "XDG_CONFIG_HOME",
                "NODE_EXTRA_CA_CERTS",
                "NODE_USE_ENV_PROXY",
                "SSL_CERT_FILE",
                "SSL_CERT_DIR",
              ].includes(key) ||
              /^(https?|all|no)_proxy$/i.test(key) ||
              /^npm_config_/i.test(key),
          ),
        ),
      };
      await writeFile(join(directory, "job.json"), JSON.stringify(job), {
        mode: 0o600,
      });
      await writeFile(statusFile + ".tmp", JSON.stringify(task), {
        mode: 0o600,
      });
      await rename(statusFile + ".tmp", statusFile);
      if (isBusy()) {
        await writeFile(
          statusFile,
          JSON.stringify({ ...task, state: "cancelled" }),
          { mode: 0o600 },
        );
        throw new Error("任务仍在运行，请结束后重试。");
      }
      switching = true;
      try {
        await run("systemd-run", [
          "--user",
          "--collect",
          "--unit=claudex-web-maintenance",
          "--property=Type=exec",
          "--",
          process.execPath,
          join(directory, "worker.mjs"),
          join(directory, "job.json"),
        ]);
      } catch (failure) {
        switching = false;
        await writeFile(
          statusFile,
          JSON.stringify({ ...task, state: "failed", error: failure.message }),
          { mode: 0o600 },
        );
        throw failure;
      }
      return status();
    } finally {
      submitting = false;
    }
  }
  return {
    get switching() {
      return switching;
    },
    check,
    status,
    start,
    initialize() {
      void check();
      timer = setInterval(() => void check(), 3600000);
      timer.unref();
    },
    close() {
      clearInterval(timer);
    },
  };
}

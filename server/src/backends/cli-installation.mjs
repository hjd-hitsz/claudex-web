import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, delimiter, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  cliEnvironment,
  cliFailure,
  installCliPackage,
} from "./cli-package.mjs";

const execute = promisify(execFile);
const packages = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
};
export async function findCli(id) {
  if (!packages[id]) throw new Error("未知后端");
  const directories = [
    dirname(process.execPath),
    ...(process.env.PATH || "").split(delimiter),
    join(homedir(), ".local", "bin"),
  ];
  for (const directory of new Set(directories.filter(Boolean))) {
    const path = join(directory, id);
    try {
      await access(path, constants.X_OK);
      return await realpath(path);
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error(
    `未找到 ${id}，请点击一键安装，或执行 npm install -g ${packages[id]}`,
  );
}

export function createCliInstallation({
  run = execute,
  locate = findCli,
  fetchVersion = latestVersion,
  changed = () => {},
} = {}) {
  let timer;
  const states = new Map();
  const pending = new Map();
  function state(id) {
    return (
      states.get(id) || {
        checking: true,
        installed: null,
        currentVersion: "",
        latestVersion: "",
      }
    );
  }
  function patch(id, values) {
    states.set(id, { ...state(id), ...values });
    changed();
  }
  function refresh(id) {
    if (!packages[id]) throw new Error("未知后端");
    if (pending.has(id)) return pending.get(id);
    const operation = (async () => {
      patch(id, { checking: true, error: "", latestError: "" });
      const [local, latest] = await Promise.allSettled([
        (async () => {
          const executable = await locate(id);
          const { stdout } = await run(executable, ["--version"], {
            timeout: 10000,
            env: cliEnvironment(),
          });
          const version = stdout.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0];
          if (!version) throw new Error("无法识别 CLI 版本：" + stdout.trim());
          return { executable, currentVersion: version };
        })(),
        fetchVersion(packages[id]),
      ]);
      patch(id, {
        checking: false,
        installed: local.status === "fulfilled",
        ...(local.status === "fulfilled"
          ? local.value
          : {
              currentVersion: "",
              executable: null,
              error: `${id === "codex" ? "Codex" : "Claude Code"} CLI 无法运行，可点击一键安装修复。`,
              errorDetails:
                local.reason.details ||
                local.reason.stderr ||
                local.reason.message,
            }),
        ...(local.status === "fulfilled" && { errorDetails: "" }),
        ...(latest.status === "fulfilled"
          ? { latestVersion: latest.value }
          : { latestError: latest.reason.message }),
      });
      return state(id);
    })().finally(() => pending.delete(id));
    pending.set(id, operation);
    return operation;
  }
  async function install(id) {
    if (!packages[id]) throw new Error("未知后端");
    patch(id, { installing: true, installError: "", installErrorDetails: "" });
    try {
      const version = await installCliPackage(id, packages[id], run);
      if (pending.has(id)) await pending.get(id);
      await refresh(id);
      if (!state(id).installed)
        throw cliFailure("安装后的 CLI 校验失败，可查看错误详情并重新安装。", {
          details: state(id).errorDetails,
        });
      if (state(id).currentVersion !== version)
        throw cliFailure("安装后的 CLI 版本不一致，可查看错误详情并重试。", {
          details: `期望版本 ${version}，实际版本 ${state(id).currentVersion}。`,
        });
    } catch (error) {
      patch(id, {
        installError: error.message,
        installErrorDetails: error.details || error.stderr || error.message,
      });
      throw error;
    } finally {
      patch(id, { installing: false });
    }
  }
  function start() {
    if (timer) return;
    const check = () => {
      for (const id of Object.keys(packages)) refresh(id).catch(() => {});
    };
    timer = setInterval(check, 60 * 60 * 1000);
    timer.unref();
    check();
  }
  function close() {
    clearInterval(timer);
    timer = undefined;
  }
  return { state, refresh, install, start, close };
}

async function latestVersion(packageName) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (!response.ok)
    throw new Error(`最新版本查询失败（HTTP ${response.status}）`);
  const data = await response.json();
  if (typeof data.version !== "string") throw new Error("npm 版本响应格式无效");
  return data.version;
}

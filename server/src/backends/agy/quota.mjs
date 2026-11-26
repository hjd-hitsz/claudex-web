import { watch } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node-pty";
import { networkProxyEnvironment } from "../network-proxy.mjs";

const statusline = fileURLToPath(
  new URL("./quota-statusline.mjs", import.meta.url),
);
const quote = (path) => "'" + path.replaceAll("'", "'\"'\"'") + "'";
const labels = { gemini: "Gemini", "3p": "第三方模型" };

export function projectAgyQuota({ quota, plan }) {
  const windows = [];
  const amounts = [];
  for (const [id, bucket] of Object.entries(quota || {})) {
    if (!bucket || bucket.disabled) continue;
    const period = /^(.*)-(5h|weekly)$/.exec(id);
    const name = labels[period?.[1]] || period?.[1];
    const label = period
      ? `${name} ${period[2] === "weekly" ? "周额度" : "5 小时额度"}`
      : id;
    const time = Date.parse(bucket.reset_time);
    const resetsAt = Number.isFinite(time)
      ? time / 1000
      : Number.isFinite(bucket.reset_in_seconds) && bucket.reset_in_seconds >= 0
        ? Math.floor(Date.now() / 1000) + bucket.reset_in_seconds
        : undefined;
    if (
      Number.isFinite(bucket.remaining_fraction) &&
      bucket.remaining_fraction >= 0 &&
      bucket.remaining_fraction <= 1
    )
      windows.push({
        id,
        label,
        usedPercent: (1 - bucket.remaining_fraction) * 100,
        resetsAt,
        ...(period && {
          shortLabel: period[2] === "weekly" ? "周" : "5h",
          windowDurationMins: period[2] === "weekly" ? 10080 : 300,
        }),
      });
    else if (
      Number.isFinite(bucket.remaining_amount) &&
      bucket.remaining_amount >= 0
    )
      amounts.push({ id, label, remaining: bucket.remaining_amount, resetsAt });
  }
  windows.sort(
    (a, b) =>
      Number(b.id.startsWith("gemini-")) - Number(a.id.startsWith("gemini-")) ||
      a.id.localeCompare(b.id),
  );
  return {
    rateLimits: {
      limitId: "agy",
      ...(plan && { planType: plan }),
      windows,
      amounts,
    },
  };
}

export function createAgyQuota(getBackend) {
  let request;
  let expires = 0;
  let snapshot;
  let stopActive;
  async function read() {
    const backend = getBackend();
    const directory = await mkdtemp(join(backend.stateDir, "quota-"));
    const output = join(directory, "status.json");
    const settings = {
      toolPermission: "strict",
      statusLine: {
        enabled: true,
        type: "command",
        command: [process.execPath, statusline, output].map(quote).join(" "),
      },
    };
    try {
      return await new Promise((resolve, reject) => {
        let child;
        let finished = false;
        const watcher = watch(directory, (type, name) => {
          if (name !== "status.json" || finished) return;
          readFile(output, "utf8").then(
            (text) => finish(null, projectAgyQuota(JSON.parse(text))),
            (error) => {
              if (error.code !== "ENOENT") finish(error);
            },
          );
        });
        const timer = setTimeout(
          () => finish(new Error("agy 状态栏暂未返回额度")),
          12000,
        );
        function finish(error, result) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          watcher.close();
          child?.kill();
          stopActive = undefined;
          if (error) reject(error);
          else resolve(result);
        }
        stopActive = () => finish(new Error("agy 执行服务已停止"));
        try {
          child = spawn(
            backend.executable,
            [
              "--agent",
              "claudex-secretary",
              "--settings",
              JSON.stringify(settings),
            ],
            {
              cwd: join(backend.stateDir, "launch"),
              name: "xterm-256color",
              cols: 100,
              rows: 26,
              env: {
                ...process.env,
                ...networkProxyEnvironment(backend.proxy),
              },
            },
          );
          child.onData(() => {});
          child.onExit(() =>
            finish(new Error("agy 状态栏已退出，额度暂时不可用")),
          );
        } catch (error) {
          finish(error);
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return {
    read() {
      if (snapshot && Date.now() < expires) return Promise.resolve(snapshot);
      request ||= read()
        .then((result) => {
          snapshot = result;
          expires = Date.now() + 55000;
          return result;
        })
        .finally(() => {
          request = undefined;
        });
      return request;
    },
    close() {
      stopActive?.();
    },
  };
}

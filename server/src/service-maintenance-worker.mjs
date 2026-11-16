import { X509Certificate } from "node:crypto";
// 此入口及进程辅助模块复制到配置目录，安装替换和网页退出后继续运行。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import https from "node:https";
import {
  processAlive,
  processIdentity,
  spawnDetached,
  stopProcess,
} from "./service-maintenance-process.mjs";
const execute = promisify(execFile);
const job = JSON.parse(await readFile(process.argv[2], "utf8"));
if (job.process) job.task.worker = await processIdentity(process.pid);
const environment = {
  ...process.env,
  ...job.environment,
  PATH:
    job.environment?.PATH ||
    `${dirname(process.execPath)}${delimiter}${process.env.PATH || ""}`,
};
const save = async (state, error = "") => {
  await writeFile(
    job.statusFile + ".tmp",
    JSON.stringify({ ...job.task, state, error }),
    { mode: 0o600 },
  );
  await rename(job.statusFile + ".tmp", job.statusFile);
};
const health = async () => {
  const ca = await readFile(job.cert);
  return new Promise((resolve) => {
    const request = https.get(
      {
        hostname: "127.0.0.1",
        port: job.port,
        path: "/healthz",
        ca,
        allowPartialTrustChain: true,
        checkServerIdentity(_hostname, peer) {
          if (peer.fingerprint256 !== new X509Certificate(ca).fingerprint256)
            return new Error("本机服务证书与配置不匹配");
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.setTimeout(3000, () => request.destroy());
    request.on("error", () => resolve(null));
  });
};
let stage,
  backup,
  replacement,
  stopped = false,
  replaced = false;
const restart = async () => {
  if (job.process) {
    await stopProcess(replacement || job.process.identity);
    stopped = true;
    replacement = await spawnDetached(
      job.process.command,
      job.process.args,
      job.process,
    );
    if (!replacement) throw new Error("网页进程启动失败，请查看维护日志。");
  } else
    await execute("systemctl", ["--user", "restart", "claudex-web.service"], {
      timeout: 90000,
    });
};
const waitHealthy = async (target) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (job.process && !(await processAlive(replacement)))
      throw new Error("网页进程启动后退出，请查看维护日志。");
    const status = await health();
    if (status?.version?.version === target) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("服务启动检查超时，请查看维护日志。");
};
let previousVersion;
try {
  await save(job.task.state);
  // 留出 HTTP 确认响应和浏览器开始轮询的时间。
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (job.action === "update") {
    previousVersion = JSON.parse(
      await readFile(join(job.root, "package.json"), "utf8"),
    ).version;
    stage = await mkdtemp(join(job.prefix, ".claudex-update-"));
    await execute(
      "npm",
      [
        "install",
        "--global",
        "--prefix",
        stage,
        `${job.packageName}@${job.task.target}`,
        "--registry=https://registry.npmjs.org",
        "--engine-strict",
      ],
      { timeout: 600000, maxBuffer: 4 * 1024 * 1024, env: environment },
    );
    const installed = join(stage, "lib/node_modules", job.packageName);
    const manifest = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    );
    if (manifest.version !== job.task.target)
      throw new Error("安装包版本校验失败");
    await readFile(join(installed, "client/dist/index.html"));
    // 普通进程先退出再替换，关闭期间仍可读取原安装的按需模块。
    if (job.process) {
      await stopProcess(job.process.identity);
      stopped = true;
    }
    backup = job.root + ".maintenance-backup";
    await rename(job.root, backup);
    try {
      await rename(installed, job.root);
      replaced = true;
    } catch (error) {
      await rename(backup, job.root);
      backup = null;
      throw error;
    }
  }
  await save("restarting");
  await restart();
  await waitHealthy(job.task.target);
  await save("completed");
  replaced = false;
  if (backup) await rm(backup, { recursive: true, force: true });
} catch (error) {
  try {
    if (replaced) {
      if (job.process) await stopProcess(replacement);
      await rm(job.root, { recursive: true, force: true });
      await rename(backup, job.root);
      await restart();
      await waitHealthy(previousVersion);
    } else if (stopped && job.process && !(await processAlive(replacement))) {
      await restart();
      await waitHealthy(previousVersion || job.task.target);
    }
  } catch (failure) {
    error.message += `；恢复原服务失败：${failure.message}`;
  }
  await save("failed", error.message);
  process.exitCode = 1;
} finally {
  if (stage) await rm(stage, { recursive: true, force: true });
}

import { X509Certificate } from "node:crypto";
// 此入口复制到配置目录后由独立 systemd 单元执行，更新期间保持可运行。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import https from "node:https";
const execute = promisify(execFile);
const job = JSON.parse(await readFile(process.argv[2], "utf8"));
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
  replaced = false;
try {
  // 留出 HTTP 确认响应和浏览器开始轮询的时间。
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (job.action === "update") {
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
      { timeout: 600000, maxBuffer: 4 * 1024 * 1024 },
    );
    const installed = join(stage, "lib/node_modules", job.packageName);
    const manifest = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    );
    if (manifest.version !== job.task.target)
      throw new Error("安装包版本校验失败");
    await readFile(join(installed, "client/dist/index.html"));
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
  await execute("systemctl", ["--user", "restart", "claudex-web.service"], {
    timeout: 90000,
  });
  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await health();
    if (status?.version?.version === job.task.target) {
      healthy = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!healthy)
    throw new Error(
      "服务启动检查超时，请查看 journalctl --user -u claudex-web.service",
    );
  await save("completed");
  replaced = false;
  if (backup) await rm(backup, { recursive: true, force: true });
} catch (error) {
  if (replaced) {
    await rm(job.root, { recursive: true, force: true });
    await rename(backup, job.root);
    await execute("systemctl", [
      "--user",
      "restart",
      "claudex-web.service",
    ]).catch(() => {});
  }
  await save("failed", error.message);
  process.exitCode = 1;
} finally {
  if (stage) await rm(stage, { recursive: true, force: true });
}

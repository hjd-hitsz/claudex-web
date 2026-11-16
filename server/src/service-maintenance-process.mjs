import { spawn } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function processIdentity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (["Z", "X"].includes(fields[0])) return null;
    return {
      pid,
      startTime: fields[19],
      bootId: (
        await readFile("/proc/sys/kernel/random/boot_id", "utf8")
      ).trim(),
    };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    throw error;
  }
}

export async function processAlive(expected) {
  if (!expected) return false;
  const actual = await processIdentity(expected.pid);
  return Boolean(
    actual &&
    actual.startTime === expected.startTime &&
    actual.bootId === expected.bootId,
  );
}

export async function stopProcess(expected, { timeout = 30000 } = {}) {
  if (!(await processAlive(expected))) return;
  process.kill(expected.pid, "SIGTERM");
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await processAlive(expected))) return;
    await delay(100);
  }
  if (!(await processAlive(expected))) return;
  console.warn("网页进程未在退出期限内结束，终止所属进程后继续重启。");
  process.kill(expected.pid, "SIGKILL");
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!(await processAlive(expected))) return;
    await delay(100);
  }
  throw new Error("网页进程尚未退出，已保留当前安装，请查看维护日志后重试。");
}

export async function spawnDetached(command, args, { env, cwd, logFile }) {
  const log = await open(logFile, "a", 0o600);
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env,
      cwd,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return await processIdentity(child.pid);
  } finally {
    await log.close();
  }
}

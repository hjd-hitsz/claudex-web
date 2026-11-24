import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
import { createBackgroundBatches } from "./background-batches.mjs";
import { readTaskLog } from "./log.mjs";
import { validateBackgroundArguments } from "./background-protocol.mjs";

const LOG_LIMIT = 64 * 1024 * 1024;
const terminal = (job) => job.status !== "running";

export async function createBackgroundJobs({
  directory,
  readThread,
  now = Date.now,
  terminateNative,
  shell = process.env.SHELL || userInfo().shell || "/bin/sh",
}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const jobs = new Map(),
    children = new Map(),
    completions = new Map(),
    terminations = new Map(),
    writes = new Map(),
    starting = new Map();
  const batches = new Map();
  let closing = false;
  const save = (kind, id, value) => {
    const key = kind + id;
    const snapshot = JSON.stringify(value);
    const next = (writes.get(key) || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const file = join(directory, `${kind}-${id}.json`);
        await writeFile(file + ".tmp", snapshot, { mode: 0o600 });
        await rename(file + ".tmp", file);
      });
    writes.set(key, next);
    return next;
  };
  for (const name of await readdir(directory)) {
    if (!/^(job|batch)-[\w-]+\.json$/.test(name)) continue;
    const value = JSON.parse(await readFile(join(directory, name), "utf8"));
    if (name.startsWith("batch-")) {
      // preparing 尚未提交 Codex；sending 的结果须由投递服务读取历史核对。
      if (value.status === "preparing") value.status = "pending";
      if (value.status === "sending") value.status = "uncertain";
      batches.set(value.id, value);
      await save("batch", value.id, value);
    } else {
      if (value.status === "running") {
        value.status = "interrupted";
        value.completedAt = now();
        value.error = "后台任务服务重启，原进程执行结果需要检查";
      }
      jobs.set(value.id, value);
      await save("job", value.id, value);
    }
  }
  const settling = new Set();
  const running = (job) =>
    !terminal(job) && !settling.has(job.id) && job.delivery !== "suppressed";
  const notifications = createBackgroundBatches({
    jobs,
    batches,
    save,
    running,
    now,
  });
  await notifications.restore();
  const owned = (threadId, id) => {
    const job = jobs.get(id);
    if (!job || job.threadId !== threadId)
      throw new Error("该对话中没有此后台任务");
    return job;
  };
  function publicJob(job) {
    const { pid, checkpoint, scheduleCalls, ...record } = job;
    return { ...record, ...notifications.checkpointView(job) };
  }
  const list = (threadId) =>
    [...jobs.values()]
      .filter((job) => !threadId || job.threadId === threadId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(publicJob);
  const logPath = (job) => join(directory, `output-${job.id}.log`);
  const read = async (threadId, id, offset) => {
    const job = owned(threadId, id);
    const output = await readTaskLog(logPath(job), offset);
    return { job: publicJob(job), ...output };
  };
  const nativeLogSizes = new Map();
  async function registerNative(threadId, turnId, item) {
    const existing = [...jobs.values()].find(
      (job) =>
        job.threadId === threadId &&
        job.native?.turnId === turnId &&
        job.native.itemId === item.id,
    );
    if (existing) return publicJob(existing);
    const job = {
      id: randomUUID(),
      threadId,
      native: { turnId, itemId: item.id, processId: item.processId },
      cwd: item.cwd,
      command: item.command,
      title: item.command,
      startedAt: item.startedAtMs ?? now(),
      completedAt: null,
      status: "running",
      exitCode: null,
      delivery: "pending",
      logTruncated: false,
    };
    await writeFile(logPath(job), "", { mode: 0o600, flag: "wx" });
    await save("job", job.id, job);
    jobs.set(job.id, job);
    return publicJob(job);
  }
  async function appendNative(threadId, id, delta) {
    const job = owned(threadId, id);
    if (terminal(job)) return;
    const size = nativeLogSizes.get(id) ?? 0;
    const bytes = Buffer.from(delta);
    const remaining = LOG_LIMIT - size;
    if (bytes.length > remaining) job.logTruncated = true;
    if (remaining <= 0) return;
    const output = bytes.subarray(0, remaining);
    await appendFile(logPath(job), output);
    nativeLogSizes.set(id, size + output.length);
  }
  async function finishNative(threadId, id, item) {
    const job = owned(threadId, id);
    if (job.completedAt || settling.has(id)) return;
    settling.add(id);
    try {
      if (typeof item.aggregatedOutput === "string")
        await writeFile(logPath(job), item.aggregatedOutput);
      nativeLogSizes.delete(id);
      job.completedAt = item.completedAtMs ?? now();
      job.exitCode = item.exitCode ?? null;
      if (job.status === "running")
        job.status = item.status === "completed" ? "succeeded" : item.status;
      await save("job", id, job);
    } finally {
      settling.delete(id);
    }
  }
  const newCheckpoint = (delay) => ({ id: randomUUID(), dueAt: now() + delay });
  async function scheduleCheck(threadId, id, delay, callId) {
    const job = owned(threadId, id);
    if (callId && job.scheduleCalls?.includes(callId))
      return { job: publicJob(job) };
    if (!running(job)) throw new Error("只能为仍在运行的后台任务设置检查时间");
    job.checkpoint = newCheckpoint(delay);
    if (callId) job.scheduleCalls = [...(job.scheduleCalls ?? []), callId];
    await save("job", id, job);
    return { job: publicJob(job) };
  }
  const start = async (threadId, callId, args) => {
    if (closing) throw new Error("后台任务服务正在停止");
    if (!callId || typeof callId !== "string")
      throw new Error("后台任务缺少工具调用标识");
    const key = JSON.stringify([threadId, callId]);
    if (starting.has(key)) return starting.get(key);
    const duplicate = [...jobs.values()].find(
      (job) => job.threadId === threadId && job.callId === callId,
    );
    if (duplicate)
      return { job: publicJob(duplicate), completion_delivery: "automatic" };
    const work = (async () => {
      const thread = await readThread(threadId);
      if (
        !thread?.cwd ||
        thread.archived ||
        thread.path?.replaceAll("\\", "/").includes("/archived_sessions/")
      )
        throw new Error("后台任务所属对话不可用");
      const job = {
        id: randomUUID(),
        threadId,
        callId,
        cwd: thread.cwd,
        command: args.command,
        title: args.title,
        startedAt: now(),
        completedAt: null,
        checkpoint: newCheckpoint(args.check_after_ms),
        status: "running",
        exitCode: null,
        delivery: "pending",
        logTruncated: false,
      };
      const logFile = await open(
        join(directory, `output-${job.id}.log`),
        "wx",
        0o600,
      );
      try {
        await save("job", job.id, job);
      } catch (error) {
        await logFile.close();
        throw error;
      }
      jobs.set(job.id, job);
      let size = 0,
        timedOut = false,
        processError;
      const log = logFile.createWriteStream();
      log.on("error", (error) => {
        processError = "保存日志失败：" + error.message;
        stopProcess(job.id);
      });
      const child = spawn(shell, ["-lc", job.command], {
        cwd: job.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      job.pid = child.pid;
      children.set(job.id, child);
      const append = (stream, chunk) => {
        const bytes = chunk.subarray(0, Math.max(0, LOG_LIMIT - size));
        size += bytes.length;
        if (bytes.length < chunk.length) job.logTruncated = true;
        if (bytes.length && !log.write(bytes)) {
          stream.pause();
          log.once("drain", () => stream.resume());
        }
      };
      child.stdout.on("data", (chunk) => append(child.stdout, chunk));
      child.stderr.on("data", (chunk) => append(child.stderr, chunk));
      child.on("error", (error) => {
        processError = error.message;
      });
      const timeout = args.timeout_ms
        ? setTimeout(() => {
            timedOut = true;
            stopProcess(job.id);
          }, args.timeout_ms)
        : null;
      let complete;
      const completion = new Promise((resolve) => (complete = resolve));
      completions.set(job.id, completion);
      child.on("close", async (code, signal) => {
        settling.add(job.id);
        clearTimeout(timeout);
        if (!log.destroyed)
          await new Promise((resolve) => {
            log.once("close", resolve);
            log.end();
          });
        children.delete(job.id);
        job.completedAt = now();
        job.exitCode = code;
        job.signal = signal;
        if (job.status === "running")
          job.status = timedOut
            ? "timed_out"
            : processError
              ? "failed"
              : code === 0
                ? "succeeded"
                : "failed";
        if (processError) job.error = processError;
        await save("job", job.id, job).catch((error) =>
          console.error("保存后台任务结果：", error.message),
        );
        settling.delete(job.id);
        completions.delete(job.id);
        complete();
      });
      await save("job", job.id, job);
      return { job: publicJob(job), completion_delivery: "automatic" };
    })().finally(() => starting.delete(key));
    starting.set(key, work);
    return work;
  };
  function stopProcess(id) {
    if (terminations.has(id)) return;
    const child = children.get(id);
    if (!child?.pid) return;
    const kill = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    kill("SIGTERM");
    let complete;
    terminations.set(id, new Promise((resolve) => (complete = resolve)));
    setTimeout(() => {
      try {
        kill("SIGKILL");
      } finally {
        terminations.delete(id);
        complete();
      }
    }, 2000);
  }
  const cancel = async (threadId, id) => {
    const job = owned(threadId, id);
    job.delivery = "suppressed";
    if (job.native && !terminal(job)) {
      await save("job", id, job);
      const result = await terminateNative(job);
      if (result.terminated) job.status = "cancelled";
      await save("job", id, job);
      return { job: publicJob(job) };
    }
    if (!terminal(job)) {
      job.status = "cancelled";
      stopProcess(id);
    }
    await Promise.all([
      save("job", id, job),
      completions.get(id),
      terminations.get(id),
    ]);
    return { job: publicJob(job) };
  };
  return {
    list,
    read,
    registerNative,
    appendNative,
    finishNative,
    async tool({ name, args, threadId, callId }) {
      validateBackgroundArguments(name, args);
      if (typeof threadId !== "string" || !threadId)
        throw new Error("缺少所属对话");
      if (name === "background_start") return start(threadId, callId, args);
      if (name === "background_schedule_check")
        return scheduleCheck(
          threadId,
          args.job_id,
          args.check_after_ms,
          callId,
        );
      if (name === "background_read") {
        const { output, ...result } = await read(
          threadId,
          args.job_id,
          args.offset,
        );
        const job = owned(threadId, args.job_id);
        if (job.completedAt) await notifications.consumeCompletion(job);
        return { ...result, output, job: publicJob(job) };
      }
      if (name === "background_list")
        return {
          jobs: list(threadId),
          checks: notifications.recentChecks(threadId),
        };
      return cancel(threadId, args.job_id);
    },
    snapshot() {
      return {
        jobs: list(),
        batches: [...batches.values()],
        dueChecks: notifications.dueThreads(),
      };
    },
    claim: notifications.claim,
    updateBatch: notifications.updateBatch,
    readyToSend: notifications.readyToSend,
    async suppressThread(threadId, cancelRunning = false) {
      const saved = [];
      for (const job of jobs.values())
        if (job.threadId === threadId) {
          if (cancelRunning) saved.push(cancel(threadId, job.id));
          else {
            job.delivery = "suppressed";
            saved.push(save("job", job.id, job));
          }
        }
      saved.push(notifications.suppressBatches(threadId));
      await Promise.all(saved);
      return {};
    },
    async close() {
      closing = true;
      await Promise.allSettled(starting.values());
      for (const [id] of children) {
        const job = jobs.get(id);
        if (job.status === "running") {
          job.status = "interrupted";
          job.error = "后台任务服务已停止";
        }
        stopProcess(id);
      }
      await Promise.all(completions.values());
      await Promise.all(terminations.values());
      await Promise.all(writes.values());
    },
  };
}

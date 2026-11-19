import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
import { readTaskLog } from "./log.mjs";
import { validateBackgroundArguments } from "./background-protocol.mjs";

const LOG_LIMIT = 64 * 1024 * 1024;
const terminal = (job) => job.status !== "running";

export async function createBackgroundJobs({
  directory,
  readThread,
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
        value.completedAt = Date.now();
        value.error = "后台任务服务重启，原进程执行结果需要检查";
      }
      jobs.set(value.id, value);
      await save("job", value.id, value);
    }
  }
  for (const batch of batches.values())
    for (const id of batch.jobIds) {
      const job = jobs.get(id);
      if (job && !["consumed", "suppressed"].includes(job.delivery)) {
        job.delivery = batch.status;
        await save("job", id, job);
      }
    }
  const owned = (threadId, id) => {
    const job = jobs.get(id);
    if (!job || job.threadId !== threadId)
      throw new Error("该对话中没有此后台任务");
    return job;
  };
  const publicJob = (job) => ({ ...job, pid: undefined });
  const list = (threadId) =>
    [...jobs.values()]
      .filter((job) => !threadId || job.threadId === threadId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(publicJob);
  const read = async (threadId, id, offset) => {
    const job = owned(threadId, id);
    const output = await readTaskLog(
      join(directory, `output-${job.id}.log`),
      offset,
    );
    return { job: publicJob(job), ...output };
  };
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
        startedAt: Date.now(),
        completedAt: null,
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
        clearTimeout(timeout);
        if (!log.destroyed)
          await new Promise((resolve) => {
            log.once("close", resolve);
            log.end();
          });
        children.delete(job.id);
        job.completedAt = Date.now();
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
  const pendingJobs = () =>
    [...jobs.values()].filter(
      (job) =>
        terminal(job) &&
        job.delivery === "pending" &&
        job.status !== "cancelled",
    );
  return {
    list,
    read,
    async tool({ name, args, threadId, callId }) {
      validateBackgroundArguments(name, args);
      if (typeof threadId !== "string" || !threadId)
        throw new Error("缺少所属对话");
      if (name === "background_start") return start(threadId, callId, args);
      if (name === "background_read") {
        const result = await read(threadId, args.job_id, args.offset);
        const job = owned(threadId, args.job_id);
        if (
          terminal(job) &&
          ["pending", "batched", "preparing"].includes(job.delivery)
        ) {
          job.delivery = "consumed";
          await save("job", job.id, job);
          for (const batch of batches.values())
            if (
              batch.jobIds.includes(job.id) &&
              batch.jobIds.every((id) =>
                ["consumed", "suppressed"].includes(jobs.get(id)?.delivery),
              )
            ) {
              batch.status = "suppressed";
              await save("batch", batch.id, batch);
            }
          result.job = publicJob(job);
        }
        return result;
      }
      if (name === "background_list") return { jobs: list(threadId) };
      return cancel(threadId, args.job_id);
    },
    snapshot() {
      return { jobs: list(), batches: [...batches.values()] };
    },
    async claim(threadId, owner) {
      const existing = [...batches.values()].find(
        (batch) =>
          batch.threadId === threadId &&
          ["pending", "preparing"].includes(batch.status),
      );
      if (existing) {
        if (
          existing.status === "preparing" &&
          existing.owner !== owner &&
          Date.now() - existing.updatedAt < 120000
        )
          return null;
        if (existing.status === "preparing") existing.status = "pending";
        if (existing.status !== "pending") return null;
        existing.owner = owner;
        existing.status = "preparing";
        existing.updatedAt = Date.now();
        await save("batch", existing.id, existing);
        return existing;
      }
      const selected = pendingJobs()
        .filter((job) => job.threadId === threadId)
        .slice(0, 8);
      if (!selected.length) return null;
      const batch = {
        id: randomUUID(),
        threadId,
        jobIds: selected.map((job) => job.id),
        owner,
        status: "preparing",
        updatedAt: Date.now(),
      };
      batches.set(batch.id, batch);
      await save("batch", batch.id, batch);
      for (const job of selected) {
        if (["consumed", "suppressed"].includes(job.delivery)) continue;
        job.delivery = "batched";
        await save("job", job.id, job);
      }
      return batch;
    },
    async updateBatch({ id, status, error, turnId, owner }) {
      const batch = batches.get(id);
      if (!batch) throw new Error("后台完成通知不存在");
      if (owner && batch.owner !== owner)
        throw new Error("后台完成通知已由另一服务处理");
      if (
        !["pending", "sending", "accepted", "uncertain", "suppressed"].includes(
          status,
        )
      )
        throw new Error("无效投递状态");
      if (["accepted", "suppressed"].includes(batch.status)) return batch;
      if (status === "sending") {
        batch.attemptedAt = Date.now();
        batch.deliveryJobIds = batch.jobIds.filter(
          (jobId) =>
            !["consumed", "suppressed"].includes(jobs.get(jobId)?.delivery),
        );
        if (!batch.deliveryJobIds.length) status = "suppressed";
      }
      Object.assign(batch, { status, error, turnId, updatedAt: Date.now() });
      for (const jobId of batch.jobIds) {
        const job = jobs.get(jobId);
        if (job && !["suppressed", "consumed"].includes(job.delivery)) {
          job.delivery = status;
          job.deliveryError = error;
          await save("job", job.id, job);
        }
      }
      await save("batch", id, batch);
      return batch;
    },
    async suppressThread(threadId, cancelRunning = false) {
      for (const job of jobs.values())
        if (job.threadId === threadId) {
          if (cancelRunning) await cancel(threadId, job.id);
          else {
            job.delivery = "suppressed";
            await save("job", job.id, job);
          }
        }
      for (const batch of batches.values())
        if (batch.threadId === threadId && batch.status !== "accepted") {
          batch.status = "suppressed";
          await save("batch", batch.id, batch);
        }
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

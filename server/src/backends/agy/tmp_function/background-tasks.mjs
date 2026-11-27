// ACP 缺口：会话缺少后台任务列举、日志读取和停止接口。
// 探测证据：agy 1.5.18 的 session/tasks/list、thread/backgroundTasks/list、
// thread/backgroundTerminals/list 均返回 -32601 Method not found。
// 切换条件：验证原生接口支持会话归属、日志读取和单项停止，再按
// docs/future_plan.md「后台任务面板与 /stop」核对产品范围和迁移。
import { join } from "node:path";
import {
  privateDirectory,
  taskRequest,
} from "../../../../../packages/background-terminal/client.mjs";
import { readTaskLog } from "../../../../../packages/background-terminal/log.mjs";
import { runtimeIdentity } from "../../../conversation-manager/address.mjs";
import { validateBackend } from "../../configuration.mjs";
import { agyPage } from "../session-store.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function summary({
  id,
  command,
  title,
  status,
  startedAt,
  completedAt,
  exitCode,
  nextCheckAt,
  checkDelivery,
}) {
  return {
    id,
    command,
    title,
    status,
    startedAt,
    completedAt,
    exitCode,
    nextCheckAt,
    checkDelivery,
  };
}

export function agyBackgroundMethods({
  config,
  store,
  request = taskRequest,
  readLog = readTaskLog,
  resolveDirectory = privateDirectory,
}) {
  const directory =
    config.backgroundTaskDir || join(config.configDir, "background-terminal");
  function tool(executor, name, args = {}) {
    return request(directory, "tool", {
      name,
      args,
      threadId: executor.threadId,
      expectedUpstream: new URL(config.upstreamUrl).href,
    });
  }

  async function locate(threadId) {
    const state = await store.read();
    const session = store.session(state, threadId);
    const delegates = Object.values(state.tasks).filter(
      (task) =>
        task.parentId === session.id &&
        task.target === "codex" &&
        task.executor?.threadId,
    );
    if (!delegates.length) return { entries: [], unavailable: false };
    const runtime = runtimeIdentity(
      validateBackend({ id: "codex", type: "codex" }, config),
    );
    const executors = new Map(
      delegates
        .map(({ executor }) => executor)
        .filter(({ runtimeId }) => runtimeId === runtime)
        .map((executor) => [executor.threadId, executor]),
    );
    const results = await Promise.allSettled(
      [...executors.values()].map(async (executor) => {
        const { jobs } = await tool(executor, "background_list");
        return jobs
          .filter(
            (job) =>
              !job.native &&
              job.threadId === executor.threadId &&
              uuid.test(job.id),
          )
          .map((job) => ({ job, executor }));
      }),
    );
    return {
      entries: results.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      ),
      unavailable: results.some(
        (result) =>
          result.status === "rejected" &&
          !["ENOENT", "ECONNREFUSED"].includes(result.reason?.code),
      ),
    };
  }

  async function owned({ threadId, taskId }) {
    const { entries, unavailable } = await locate(threadId);
    const entry = entries.find(({ job }) => job.id === taskId);
    if (entry) return entry;
    throw new Error(
      unavailable ? "暂时无法读取后台终端" : "该对话中没有此后台终端",
    );
  }
  const running = ({ job }) => job.status === "running";
  async function stop({ job, executor }) {
    if (job.status === "running")
      await tool(executor, "background_cancel", { job_id: job.id });
    return {};
  }

  return new Map([
    [
      "thread/backgroundTasks/list",
      async ({ threadId }) => {
        const { entries } = await locate(threadId);
        return {
          tasks: entries.filter(running).map(({ job }) => summary(job)),
        };
      },
    ],
    [
      "thread/backgroundTasks/read",
      async (params) => {
        const { job } = await owned(params);
        // 网页查看日志时保留执行端的任务完成投递状态。
        const logPath = join(
          await resolveDirectory(directory),
          `output-${job.id}.log`,
        );
        const { output, offset } = await readLog(logPath, undefined, 8192);
        return { ...summary(job), output, logPath, truncated: offset > 0 };
      },
    ],
    [
      "thread/backgroundTasks/cancel",
      async (params) => stop(await owned(params)),
    ],
    [
      "thread/backgroundTerminals/list",
      async (params) => {
        const { entries } = await locate(params.threadId);
        return agyPage(
          entries.filter(running).map(({ job }) => ({
            processId: job.id,
            command: job.command,
            cwd: job.cwd,
          })),
          params,
        );
      },
    ],
    [
      "thread/backgroundTerminals/clean",
      async ({ threadId }) => {
        const { entries, unavailable } = await locate(threadId);
        const results = await Promise.allSettled(
          entries.filter(running).map(stop),
        );
        if (unavailable || results.some(({ status }) => status === "rejected"))
          throw new Error("部分后台终端暂时无法停止，请刷新后重试");
        return {};
      },
    ],
  ]);
}

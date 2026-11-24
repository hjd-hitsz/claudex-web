import { join } from "node:path";
import {
  privateDirectory,
  taskRequest,
} from "../../../../packages/background-terminal/client.mjs";
import { readTaskLog } from "../../../../packages/background-terminal/log.mjs";
import type { NativeParams } from "./native-protocol.d.mts";
import type { createBackgroundService } from "./background-service.mjs";

type Job = {
  id: string;
  title: string;
  command: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  delivery?: string;
  exitCode?: number | null;
  nextCheckAt?: number;
  checkDelivery?: string;
};
type CheckReceipt = { id: string; deliveredAt: number };

export function backgroundTaskViews(
  background: ReturnType<typeof createBackgroundService> | undefined,
  upstream: string,
) {
  const expectedUpstream = new URL(upstream).href;
  function tool(
    threadId: string,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    if (!background) throw new Error("Codex 后台任务服务不可用");
    return taskRequest(background.directory, "tool", {
      name,
      args,
      threadId,
      expectedUpstream,
    });
  }
  const list = async (
    threadId?: string,
  ): Promise<{ jobs: Job[]; checks?: CheckReceipt[] }> => {
    if (!background?.available || !background.listening()) return { jobs: [] };
    if (typeof threadId !== "string" || !threadId)
      throw new Error("缺少所属对话");
    return (await tool(threadId, "background_list")) as {
      jobs: Job[];
      checks?: CheckReceipt[];
    };
  };
  const summary = ({
    id,
    title,
    command,
    status,
    startedAt,
    completedAt,
    delivery,
    exitCode,
    nextCheckAt,
    checkDelivery,
  }: Job) => ({
    id,
    title,
    command,
    status,
    startedAt,
    completedAt,
    delivery,
    exitCode,
    nextCheckAt,
    checkDelivery,
  });
  async function owned({ threadId, taskId }: NativeParams) {
    const { jobs } = await list(threadId);
    const job = jobs.find((job) => job.id === taskId);
    if (!job || !/^[a-f0-9-]{36}$/.test(job.id))
      throw new Error("该对话中没有此后台任务");
    return job;
  }
  return new Map<string, (params: NativeParams) => Promise<unknown>>([
    [
      "thread/backgroundTasks/list",
      async ({ threadId }) => {
        const { jobs, checks } = await list(threadId);
        return {
          checks,
          tasks: jobs.filter((job) => job.status === "running").map(summary),
          completed: jobs
            .filter(
              (job) => job.status !== "running" && job.delivery === "accepted",
            )
            .slice(0, 20)
            .map(summary),
        };
      },
    ],
    [
      "thread/backgroundTasks/read",
      async (params) => {
        const job = await owned(params);
        if (!background) throw new Error("Codex 后台任务服务不可用");
        const directory = await privateDirectory(background.directory);
        // 查看输出保留原任务服务的完成投递状态。
        const logPath = join(directory, `output-${job.id}.log`);
        const { output, offset } = await readTaskLog(logPath, undefined, 8192);
        return { ...summary(job), output, logPath, truncated: offset > 0 };
      },
    ],
    [
      "thread/backgroundTasks/cancel",
      async (params) => {
        const job = await owned(params);
        if (job.status === "running" && params.threadId)
          return await tool(params.threadId, "background_cancel", {
            job_id: job.id,
          });
        return {};
      },
    ],
  ]);
}

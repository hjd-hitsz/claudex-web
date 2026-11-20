import { page } from "./history.mjs";
import {
  captureNativeProcesses,
  nativeProcessesAlive,
  recoverNativeProcesses,
} from "./process-ownership.mjs";

const shellTask = (task) =>
  task?.is_backgrounded &&
  !task.ambient &&
  ["local_bash", "shell", "local_shell"].includes(task.task_type);
const activeTask = (task) =>
  ["running", "pending", "unknown"].includes(task.status);

export function createBackgroundTasks({ storage, save, emit }) {
  const owners = new Map();
  async function event(threadId, message, process) {
    if (message.type !== "system") return;
    const subtype = message.subtype;
    if (
      ["task_started", "background_tasks_changed"].includes(subtype) &&
      process.child?.pid
    ) {
      const { owner, children } = await captureNativeProcesses(
        process.child.pid,
      );
      await save(threadId, (s) => ({
        ...s,
        nativeProcess: owner,
        nativeChildren: children,
      }));
    }
    if (subtype === "background_tasks_changed") {
      const live = new Set(message.tasks.map((task) => task.task_id));
      for (const task of message.tasks)
        owners.set(`${threadId}/${task.task_id}`, process);
      await save(threadId, (s) => {
        const tasks = { ...s.backgroundTasks };
        for (const [id, task] of Object.entries(tasks))
          if (task.is_backgrounded && activeTask(task) && !live.has(id))
            tasks[id] = { ...task, status: "stopped" };
        for (const task of message.tasks) {
          const previous = tasks[task.task_id];
          tasks[task.task_id] = {
            ...previous,
            ...task,
            startedAt: previous?.startedAt ?? Date.now(),
            status: "running",
            is_backgrounded: true,
          };
        }
        return { ...s, backgroundTasks: tasks };
      });
    } else if (
      [
        "task_started",
        "task_progress",
        "task_updated",
        "task_notification",
      ].includes(subtype)
    ) {
      const id = message.task_id;
      owners.set(`${threadId}/${id}`, process);
      if (subtype === "task_started" && message.task_type === "local_agent") {
        const agentId = `agent/${threadId}/${id}`;
        let details;
        await save(threadId, (s) => {
          const call = s.agentCalls?.[message.tool_use_id];
          details = {
            ...s.agents?.[agentId],
            ...call,
            agentId: id,
            name: call?.name || message.description || message.subagent_type,
            initialTask: message.prompt || call?.initialTask,
            toolUseId: message.tool_use_id,
            parentNativeId: message.session_id,
          };
          return { ...s, agents: { ...s.agents, [agentId]: details } };
        });
        const turnId = process.lastTurnId;
        const item = {
          id: `agent-${id}`,
          turnId,
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: agentId,
          agentPath: details.name,
          prompt: details.initialTask,
        };
        await save(threadId, (s) => ({
          ...s,
          extraItems: { ...s.extraItems, [item.id]: item },
        }));
        emit("item/completed", { threadId, turnId, item });
      }
      await save(threadId, (s) => ({
        ...s,
        backgroundTasks: {
          ...s.backgroundTasks,
          [id]: {
            ...s.backgroundTasks?.[id],
            ...message,
            ...message.patch,
            ...(subtype === "task_started" && {
              status: "running",
              startedAt: s.backgroundTasks?.[id]?.startedAt ?? Date.now(),
            }),
          },
        },
      }));
    } else return;
    emit("thread/backgroundTerminals/updated", { threadId });
  }
  async function records(p) {
    const session = (await storage.read()).sessions[p.threadId];
    if (!session) throw new Error("对话不存在");
    const ended = new Set();
    for (const task of Object.values(session.backgroundTasks || {})) {
      if (task.status !== "unknown" || !task.nativeProcess) continue;
      if (await nativeProcessesAlive(task)) continue;
      ended.add(task.task_id);
      await save(p.threadId, (s) => ({
        ...s,
        backgroundTasks: {
          ...s.backgroundTasks,
          [task.task_id]: {
            ...s.backgroundTasks[task.task_id],
            status: "stopped",
          },
        },
      }));
    }
    const tasks = Object.values(session.backgroundTasks || {})
      .filter(
        (task) =>
          !ended.has(task.task_id) && shellTask(task) && activeTask(task),
      )
      .map((task) => ({
        processId: task.task_id,
        startedAt: task.startedAt,
        command: task.description || task.summary || "后台终端",
        cwd: session.cwd,
        status: task.status,
      }));
    return tasks;
  }
  async function stopTask(threadId, taskId) {
    const process = owners.get(`${threadId}/${taskId}`);
    if (!process?.query) {
      const session = (await storage.read()).sessions[threadId];
      const previous = session.backgroundTasks[taskId];
      if (!previous.nativeProcess)
        throw new Error("后台终端缺少可核对的进程身份，请检查原后端进程。");
      await recoverNativeProcesses(previous);
    } else await process.query.stopTask(taskId);
    await save(threadId, (s) => ({
      ...s,
      backgroundTasks: {
        ...s.backgroundTasks,
        [taskId]: { ...s.backgroundTasks[taskId], status: "stopped" },
      },
    }));
    emit("thread/backgroundTerminals/updated", { threadId });
  }
  async function readTask({ threadId, taskId }) {
    const task = (await storage.read()).sessions[threadId]?.backgroundTasks?.[
      taskId
    ];
    if (!shellTask(task)) throw new Error("该对话中没有此后台任务");
    const query = owners.get(`${threadId}/${taskId}`)?.query;
    if (!query?.getTaskOutput) throw new Error("原生后台终端输出当前不可读取");
    const result = await query.getTaskOutput(taskId);
    return {
      id: taskId,
      title: task.description || task.summary || "后台终端",
      status: activeTask(task) ? "running" : task.status,
      output: result.output,
      truncated: result.truncated,
    };
  }
  async function clean(p) {
    const data = await records(p);
    const results = await Promise.allSettled(
      data.map((task) => stopTask(p.threadId, task.processId)),
    );
    const errors = results.filter((r) => r.status === "rejected");
    if (errors.length)
      throw new Error(errors.map((r) => r.reason.message).join("\n"));
    return { stopped: data.length };
  }
  return {
    event,
    handlers: new Map([
      [
        "thread/backgroundTerminals/list",
        async (p) => page(await records(p), p),
      ],
      ["thread/backgroundTerminals/clean", clean],
      [
        "thread/backgroundTasks/list",
        async (p) => ({
          tasks: (await records(p)).map((task) => ({
            id: task.processId,
            title: task.command,
            status: "running",
            startedAt: task.startedAt,
          })),
        }),
      ],
      ["thread/backgroundTasks/read", readTask],
      [
        "thread/backgroundTasks/cancel",
        async (p) => {
          if ((await records(p)).some((task) => task.processId === p.taskId))
            await stopTask(p.threadId, p.taskId);
          return {};
        },
      ],
    ]),
  };
}

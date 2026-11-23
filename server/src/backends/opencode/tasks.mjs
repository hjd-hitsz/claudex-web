import { page } from "./messages.mjs";
export function createOpenCodeTasks({ sdk, sessions, notify }) {
  let jobs = [];
  async function refresh() {
    jobs = await sdk().experimental.job.list();
  }
  function snapshot() {
    return Object.fromEntries(
      [
        ...new Set(
          jobs.filter((j) => j.status === "running").map((j) => j.sessionID),
        ),
      ].map((id) => [
        id,
        jobs.filter((j) => j.sessionID === id && j.status === "running"),
      ]),
    );
  }
  async function owned(p) {
    const sessionID = await sessions.nativeId(p.threadId);
    return sdk().experimental.job.list({ sessionID, descendants: true });
  }
  async function stop(job) {
    if (job.kind === "shell") {
      const info = await sdk().sessions.get({ sessionID: job.sessionID });
      await sdk().shell.remove({ id: job.shellID, location: info.location });
    } else if (job.kind === "subagent")
      await sdk().sessions.interrupt({
        sessionID: job.childSessionID,
        resume: false,
      });
    else throw new Error("该 OpenCode 任务通过所属对话的停止操作结束。");
  }
  async function request(method, p) {
    if (!method.startsWith("thread/background")) return;
    const jobs = await owned(p);
    const tasks = jobs.map((j) => ({
      id: j.id,
      title: j.title || j.command || j.description || j.kind,
      status: j.status,
      startedAt: j.time.started,
      kind: j.kind,
    }));
    if (method === "thread/backgroundTasks/list") return { tasks };
    if (method === "thread/backgroundTerminals/list")
      return page(
        jobs
          .filter((j) => j.kind === "shell" && j.status === "running")
          .map((j) => ({
            processId: j.id,
            command: j.command,
            status: j.status,
            startedAt: j.time.started,
          })),
        p,
      );
    if (method === "thread/backgroundTerminals/clean") {
      const running = jobs.filter(
        (j) => j.kind === "shell" && j.status === "running",
      );
      await Promise.all(running.map(stop));
      await refresh();
      notify("thread/backgroundTerminals/updated", { threadId: p.threadId });
      return { stopped: running.length };
    }
    const job = jobs.find((j) => j.id === p.taskId);
    if (!job) throw new Error("该对话中没有此后台任务");
    if (method === "thread/backgroundTasks/cancel") {
      await stop(job);
      await refresh();
      notify("thread/backgroundTerminals/updated", { threadId: p.threadId });
      return {};
    }
    if (method === "thread/backgroundTasks/read") {
      const task = tasks.find((t) => t.id === job.id);
      if (job.kind === "shell") {
        const info = await sdk().sessions.get({ sessionID: job.sessionID });
        const result = await sdk().shell.output({
          id: job.shellID,
          location: info.location,
        });
        return {
          ...task,
          output: result.data.output,
          truncated: result.data.truncated,
        };
      }
      if (job.kind === "subagent")
        return {
          ...task,
          output: (await sessions.turns(job.childSessionID))
            .flatMap((t) => t.items)
            .map((i) => i.text || "")
            .filter(Boolean)
            .join("\n"),
          truncated: false,
        };
      return { ...task, output: job.path || "", truncated: false };
    }
  }
  return { refresh, snapshot, request };
}

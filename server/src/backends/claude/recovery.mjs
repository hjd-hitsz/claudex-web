import { nativeProcessesAlive } from "./process-ownership.mjs";

export async function recoverClaudeSessions(storage) {
  const resumable = [];
  await storage.update(async (data) => {
    const sessions = {};
    for (const [id, session] of Object.entries(data.sessions)) {
      const alive = await nativeProcessesAlive(session);
      const stopped = alive === false;
      sessions[id] = {
        ...session,
        active: null,
        backgroundTasks: Object.fromEntries(
          Object.entries(session.backgroundTasks || {}).map(([key, task]) => [
            key,
            ["running", "pending", "unknown"].includes(task.status)
              ? {
                  ...task,
                  status: stopped ? "stopped" : "unknown",
                  reason: "bridge_restart",
                  nativeProcess: task.nativeProcess || session.nativeProcess,
                  nativeChildren: task.nativeChildren || session.nativeChildren,
                }
              : task,
          ]),
        ),
        goal:
          session.goal?.status === "active"
            ? { ...session.goal, status: "paused" }
            : session.goal,
        turns: Object.fromEntries(
          Object.entries(session.turns || {}).map(([key, turn]) => [
            key,
            turn.status === "inProgress"
              ? {
                  ...turn,
                  status: "interrupted",
                  completedAt: Date.now() / 1000,
                }
              : turn,
          ]),
        ),
        queue: [
          ...(session.active &&
          !session.active.automatic &&
          !session.active.peer
            ? [{ ...session.active, status: "uncertain" }]
            : []),
          ...(session.queue || []).map((entry) =>
            entry.peer ? entry : { ...entry, status: "uncertain" },
          ),
        ],
      };
      if (
        !alive &&
        sessions[id].queue[0]?.peer &&
        sessions[id].queue[0].status === "queued"
      )
        resumable.push(id);
    }
    return { ...data, sessions };
  });
  return resumable;
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
export async function claudeWorkerState(adapter, dataDir) {
  let sessions = {};
  try {
    sessions = JSON.parse(
      await readFile(join(dataDir, "claudex-web-index.json"), "utf8"),
    ).sessions;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const state = adapter.state();
  return {
    ...state,
    params: {
      ...state.params,
      backgroundTasks: Object.fromEntries(
        Object.entries(sessions)
          .map(([id, session]) => [
            id,
            Object.values(session.backgroundTasks || {}).filter((task) =>
              ["running", "pending", "unknown"].includes(task.status),
            ),
          ])
          .filter(([, tasks]) => tasks.length),
      ),
      queuedInputs: Object.fromEntries(
        Object.entries(sessions)
          .filter(([, session]) => session.queue?.length)
          .map(([id, session]) => [id, session.queue.length]),
      ),
    },
  };
}

import { useMemo, useState } from "react";
import { refreshBackgroundResults, rpc } from "../../store.js";
import { useBackgroundPoll } from "./use-background-poll.js";

const empty = { tasks: [], stopping: null, error: "" };

export function useBackgroundTasks(threadId, enabled) {
  const scope = useMemo(
    () => ({ seen: new Set(), watched: new Set() }),
    [threadId],
  );
  const [snapshot, setSnapshot] = useState({ ...empty, scope });
  const state = snapshot.scope === scope ? snapshot : empty;
  if (snapshot.scope !== scope) setSnapshot({ ...empty, scope });

  function update(patch) {
    setSnapshot((previous) =>
      previous.scope === scope ? { ...previous, ...patch(previous) } : previous,
    );
  }

  useBackgroundPoll(
    Boolean(enabled && threadId && !state.stopping),
    1500,
    async (current) => {
      try {
        const { tasks, completed = [] } = await rpc(
          "thread/backgroundTasks/list",
          { threadId },
        );
        if (!current()) return;
        update(() => ({ tasks, error: "" }));
        for (const task of tasks) scope.watched.add(task.id);
        const pending = completed
          .filter(
            (task) =>
              !scope.seen.has(task.id) &&
              (scope.watched.has(task.id) ||
                Date.now() - task.completedAt < 300000),
          )
          .map((task) => task.id);
        if (pending.length) {
          const found = await refreshBackgroundResults(threadId, pending);
          if (current())
            for (const id of found) {
              scope.seen.add(id);
              scope.watched.delete(id);
            }
        }
      } catch (failure) {
        if (current()) update(() => ({ error: failure.message }));
      }
    },
    scope,
  );

  async function stop(task) {
    update(() => ({ stopping: task.id, error: "" }));
    try {
      await rpc("thread/backgroundTasks/cancel", { threadId, taskId: task.id });
      update(({ tasks }) => ({
        tasks: tasks.filter((entry) => entry.id !== task.id),
      }));
    } catch (failure) {
      update(() => ({ error: failure.message }));
    } finally {
      update(() => ({ stopping: null }));
    }
  }

  return { ...state, stop };
}

import { useMemo, useState } from "react";
import { backgroundCheckKey } from "../../domain/background-results.js";
import { refreshBackgroundResults, rpc } from "../../store.js";
import { useBackgroundPoll } from "./use-background-poll.js";

const empty = { tasks: [], stopping: null, readError: "", stopError: null };

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
        const {
          tasks,
          completed = [],
          checks = [],
        } = await rpc("thread/backgroundTasks/list", { threadId });
        if (!current()) return;
        update(({ stopError }) => ({
          tasks,
          readError: "",
          stopError: tasks.some((task) => task.id === stopError?.id)
            ? stopError
            : null,
        }));
        for (const task of tasks) scope.watched.add(task.id);
        const pending = completed
          .filter(
            (task) =>
              !scope.seen.has(task.id) &&
              (scope.watched.has(task.id) ||
                Date.now() - task.completedAt < 300000),
          )
          .map((task) => task.id);
        for (const check of checks) {
          const key = backgroundCheckKey(check.id);
          if (!scope.seen.has(key) && Date.now() - check.deliveredAt < 300000)
            pending.push(key);
        }
        if (pending.length) {
          const found = await refreshBackgroundResults(threadId, pending);
          if (current())
            for (const id of found) {
              scope.seen.add(id);
              scope.watched.delete(id);
            }
        }
      } catch (failure) {
        if (current()) update(() => ({ readError: failure.message }));
      }
    },
    scope,
  );

  async function stop(task) {
    update(() => ({ stopping: task.id, stopError: null }));
    try {
      await rpc("thread/backgroundTasks/cancel", { threadId, taskId: task.id });
      update(({ tasks }) => ({
        tasks: tasks.filter((entry) => entry.id !== task.id),
      }));
    } catch (failure) {
      update(() => ({ stopError: { id: task.id, message: failure.message } }));
    } finally {
      update(() => ({ stopping: null }));
    }
  }

  return {
    tasks: state.tasks,
    stopping: state.stopping,
    error: state.stopError?.message || state.readError,
    stop,
  };
}

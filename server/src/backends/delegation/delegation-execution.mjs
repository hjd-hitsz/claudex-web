import { readRolloutTrace } from "../codex/rollout-tools.mjs";
import { executing, finishDelegation } from "./delegation-store.mjs";
import {
  awaitingCodexJob,
  delegationResults,
  initialTurn,
  saveDelegationResults,
} from "./delegation-results.mjs";

export function createDelegationExecution({
  store,
  executor,
  publish,
  wake,
  syncRequests,
  resolveRequest,
}) {
  const dispatching = new Set();
  const reconciling = new Set();

  async function changeStep(id, stepId, update) {
    const task = await store.change((data) => {
      const current = data.tasks[id];
      const step = current.steps.at(-1);
      if (step.id !== stepId || !executing.has(current.status)) return null;
      if (update(current, step, data) === false) return null;
      return current;
    });
    if (task) publish(task);
    return task;
  }

  async function dispatch(task, step) {
    let submitted = false;
    try {
      const entry = await executor.resolve(task);
      if (!entry.adapter.ready) return;
      const readTask = async () => (await store.read()).tasks[task.id];
      task = await readTask();
      if (task.steps.at(-1).id !== step.id || task.status !== "accepted")
        return;

      if (!task.executor) {
        const { thread } = await executor.call(
          entry,
          "thread/start",
          executor.startParams(task),
          {
            researchStart: task.target === "codex" && task.scope === "research",
          },
        );
        if (!thread?.id) throw new Error("执行端未返回会话 ID");
        // Reuse the newly allocated session even when its original step was replaced.
        task = await store.change((data) => {
          const current = data.tasks[task.id];
          current.executor ??= {
            runtimeId: entry.runtimeId,
            threadId: thread.id,
          };
          return current;
        });
        entry.subscriptions.add(thread.id);
        if (task.steps.at(-1).id !== step.id) return;
      } else {
        await executor.attach(entry, task);
        await executor.takeover(entry, task);
      }
      const sending = await changeStep(task.id, step.id, (current, step) => {
        if (current.status !== "accepted") return false;
        current.status = "starting";
        step.submittedAt = Date.now();
      });
      if (!sending) return;
      if ((await readTask()).steps.at(-1).id !== step.id) return;
      submitted = true;
      const { turn } = await executor.call(
        entry,
        "turn/start",
        executor.turnParams(sending),
      );
      const current = await store.change((data) => {
        const current = data.tasks[task.id];
        const started = current.steps.find(({ id }) => id === step.id);
        started.turnId = turn.id;
        if (current.steps.at(-1) === started && current.status === "starting")
          current.status = "running";
        return current;
      });
      if (current.steps.at(-1).id === step.id) {
        publish(current);
        await syncRequests(entry, current);
      }
    } catch (error) {
      // An ambiguous native submission is reconciled by its marker in history.
      if (!task.executor || (submitted && error.nativeCode === -32602))
        await changeStep(task.id, step.id, (task, _step, data) =>
          finishDelegation(
            data,
            task,
            error.nativeCode ? "failed" : "unknown",
            {
              error: error.message,
            },
          ),
        );
    }
  }

  async function reconcile(task, step) {
    if (!task.executor) {
      await changeStep(task.id, step.id, (task) => {
        task.status = "accepted";
      });
      return;
    }
    const entry = await executor.resolve(task);
    if (!entry.adapter.ready) return;
    await executor.attach(entry, task);
    const { threadId } = task.executor;
    const { thread } = await executor.call(entry, "thread/read", {
      threadId,
      includeTurns: true,
    });
    const occupied = () =>
      Boolean(entry.adapter.state().params.activeTurns?.[threadId]) ||
      thread.status?.type === "active";
    const turn = initialTurn(thread.turns || [], step);
    if (!turn) {
      if (
        Date.now() - (step.submittedAt ?? step.acceptedAt) > 30000 &&
        !occupied() &&
        !entry.adapter.state().params.queuedInputs?.[threadId]
      ) {
        const background = await executor.backgrounds(entry, threadId);
        if (
          background.terminals.some(
            ({ startedAt }) => startedAt >= step.acceptedAt,
          ) ||
          background.jobs.some(
            (job) => awaitingCodexJob(job, step) && job.delivery !== "accepted",
          )
        )
          return;
        await changeStep(task.id, step.id, (task, _step, data) =>
          finishDelegation(data, task, "unknown", {
            error: "原生历史尚无可核对的轮次回执",
          }),
        );
      }
      return;
    }

    const active = ["inProgress", "queued"].includes(turn.status);
    const background = active
      ? null
      : await executor.backgrounds(entry, threadId);
    let result = active
      ? null
      : delegationResults(
          thread,
          turn,
          step,
          background,
          occupied(),
          task.target,
        );
    if (active || result.pending) {
      const turnIds = result?.turnIds ?? [turn.id];
      const current =
        turnIds.join() === (step.turnIds ?? [step.turnId]).join()
          ? task
          : await changeStep(task.id, step.id, (_task, step) => {
              step.turnId = turn.id;
              step.turnIds = turnIds;
            });
      if (current) await syncRequests(entry, current);
      return;
    }

    if (task.target === "codex" && thread.path) {
      const rollout = await readRolloutTrace(thread, new Set(result.turnIds));
      result = delegationResults(
        thread,
        turn,
        step,
        background,
        false,
        task.target,
        rollout,
      );
    }

    let request;
    const completed = await changeStep(
      task.id,
      step.id,
      (task, _step, data) => {
        request = task.request;
        saveDelegationResults(data, task, result);
      },
    );
    if (completed && request) resolveRequest(task.parentId, request.localId);
  }

  function scan(tasks) {
    for (const task of Object.values(tasks)) {
      if (!executing.has(task.status) || dispatching.has(task.id)) continue;
      const step = task.steps.at(-1);
      const dispatchTask = task.status === "accepted";
      const running = dispatchTask ? dispatching : reconciling;
      const key = dispatchTask ? task.id : step.id;
      if (running.has(key)) continue;
      running.add(key);
      (dispatchTask ? dispatch : reconcile)(task, step)
        .catch(console.error)
        .finally(async () => {
          running.delete(key);
          if (
            dispatchTask &&
            (await store.read()).tasks[task.id]?.steps.at(-1).id !== step.id
          )
            wake();
        })
        .catch(console.error);
    }
  }

  async function cancel(parentId, id) {
    const task = (await store.read()).tasks[id];
    if (!task || task.parentId !== parentId || !executing.has(task.status))
      throw new Error("委派任务不存在或已经结束");
    const step = task.steps.at(-1);
    if (task.status === "accepted" && !task.executor && !dispatching.has(id)) {
      await changeStep(id, step.id, (task, _step, data) =>
        finishDelegation(data, task, "stopped_by_user", {}),
      );
    } else {
      if (!task.executor) throw new Error("执行端正在创建原生对话");
      const entry = await executor.resolve(task);
      const current = await changeStep(id, step.id, (_task, step) => {
        step.stopRequested = true;
      });
      if (!current) throw new Error("委派步骤已更换");
      await executor.stop(entry, current);
    }
    wake();
    return {};
  }

  return { scan, cancel, changeStep };
}

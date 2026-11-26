import { randomUUID } from "node:crypto";
import { delegationSummaries } from "./delivery-summary.mjs";
import { currentResultNotice, executing } from "./delegation-store.mjs";
import {
  delegationHistoryEvent,
  delegationThreadId,
  isDelegationHistoryEvent,
  readDelegationHistory,
} from "./delegation-history.mjs";
import { createExecutors, executorLabel } from "./executors.mjs";
import { readDelegationStep } from "./step-details.mjs";
import { createDelegationExecution } from "./delegation-execution.mjs";

const requestMethods = new Set([
  "item/tool/requestUserInput",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
  "lan/agy/permission",
]);

export function createDelegationRuntime({
  store,
  config,
  version,
  emit,
  deliver,
  validateParent,
  changed,
  resourceThreadId = (_task, id) => id,
}) {
  let timer;
  let readingEventTasks;
  let stopped = false;
  const executor = createExecutors({
    config,
    version,
    onEvent: (entry, event) => onEvent(entry, event).catch(console.error),
  });
  const runner = createDelegationExecution({
    store,
    executor,
    publish,
    wake,
    syncRequests,
    resolveRequest,
  });

  function taskItem(task) {
    const { id, parentId, target, status, selection } = task;
    const agentId = resourceThreadId(task, delegationThreadId(id));
    const item = {
      id: agentId,
      type: "subAgentActivity",
      kind: "interacted",
      agentThreadId: agentId,
      agentPath: executorLabel(target),
      agentStatus: status,
      model: selection.model,
      reasoningEffort: selection.effort,
      prompt: task.steps[0].request,
      delegation: {
        taskId: id,
        parentId,
        target,
        status,
        executorThreadId: task.executor?.threadId,
        summaries: delegationSummaries(task.steps),
      },
    };
    return item;
  }

  function publish(task) {
    changed?.();
    emit({
      method: "item/completed",
      params: {
        threadId: task.parentId,
        turnId: task.parentTurnId,
        item: taskItem(task),
      },
    });
  }

  function externalRequest(task) {
    return {
      id: task.request.localId,
      method: task.request.native.method,
      params: {
        ...task.request.native.params,
        threadId: task.parentId,
        turnId: task.steps.at(-1).parentTurnId,
        executorName: executorLabel(task.target),
        delegationTaskId: task.id,
      },
    };
  }
  function resolveRequest(threadId, requestId) {
    emit({
      method: "serverRequest/resolved",
      params: { threadId, requestId },
    });
  }
  async function recordRequest(task, event) {
    const step = task.steps.at(-1);
    const belongs = ({ turnId, turnIds }) =>
      event.params?.turnId &&
      (event.params.turnId === turnId ||
        turnIds?.includes(event.params.turnId));
    if (!belongs(step)) return;
    const localId = randomUUID();
    const updated = await runner.changeStep(
      task.id,
      step.id,
      (task, current) => {
        if (
          !belongs(current) ||
          String(task.request?.native.id) === String(event.id)
        )
          return false;
        task.request = { localId, native: event };
        task.status = "waiting";
      },
    );
    if (updated?.request?.localId === localId) emit(externalRequest(updated));
  }
  async function syncRequests(entry, task) {
    const questions = entry.adapter.state().params.questions || [];
    for (const event of questions)
      if (
        event.params?.threadId === task.executor.threadId &&
        requestMethods.has(event.method)
      )
        await recordRequest(task, event);
  }
  async function onEvent(entry, event) {
    if (stopped) return;
    if (event.method === "lan/state") {
      if (entry.adapter.ready) wake();
      return;
    }
    const threadId = event.params?.threadId;
    const history = isDelegationHistoryEvent(event);
    const request = event.id !== undefined && requestMethods.has(event.method);
    const reconcile =
      event.method === "turn/completed" ||
      event.method === "thread/backgroundTerminals/updated";
    if (!threadId || !(history || request || reconcile)) return;
    // A stream of deltas shares the current disk read of the task index.
    readingEventTasks ??= store
      .read()
      .then(({ tasks }) => Object.values(tasks))
      .finally(() => {
        readingEventTasks = undefined;
      });
    const tasks = await readingEventTasks;
    if (stopped) return;
    const task = tasks.find(
      (task) =>
        task.executor?.runtimeId === entry.runtimeId &&
        task.executor.threadId === threadId &&
        (history || executing.has(task.status)),
    );
    if (!task) return;
    if (history) {
      const message = delegationHistoryEvent(task, event);
      message.params.threadId = resourceThreadId(task, message.params.threadId);
      emit(message);
    }
    if (request) await recordRequest(task, event);
    if (reconcile) wake();
  }

  async function respond({ id, threadId, result, error }) {
    const task = Object.values((await store.read()).tasks).find(
      (task) => task.request?.localId === id,
    );
    if (!task || (threadId && task.parentId !== threadId))
      throw new Error("委派审批已结束或会话不匹配");
    const entry = await executor.resolve(task);
    if ((await store.read()).tasks[task.id]?.request?.localId !== id)
      throw new Error("委派审批已结束");
    await executor.respond(entry, task.request.native, result, error);
    await runner.changeStep(task.id, task.steps.at(-1).id, (task) => {
      if (task.request?.localId !== id) return false;
      task.request = null;
      if (task.status === "waiting") task.status = "running";
    });
    resolveRequest(task.parentId, id);
    wake();
  }

  async function scan() {
    timer = undefined;
    if (stopped) return;
    const state = await store.read();
    runner.scan(state.tasks);
    for (const notice of Object.values(state.notices))
      if (
        ["queued", "submitting"].includes(notice.status) &&
        currentResultNotice(state, notice)
      )
        deliver(notice, state).catch(console.error);
    if (!stopped && !timer) {
      timer = setTimeout(wake, 2500);
      timer.unref();
    }
  }
  function wake() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => scan().catch(console.error), 0);
    timer.unref();
  }

  return {
    publish,
    wake,
    resolveRequest,
    project: taskItem,
    respond,
    cancel: runner.cancel,
    readStep: (parent, input) =>
      readDelegationStep(store, executor, parent, input),
    history: (method, params) =>
      readDelegationHistory(store, executor, method, params, validateParent),
    async snapshot() {
      const { tasks } = await store.read();
      const records = Object.values(tasks);
      return {
        questions: records
          .filter(({ request }) => request)
          .map(externalRequest),
        pending: Object.fromEntries(
          records
            .filter(({ status }) => executing.has(status))
            .map(({ id, status }) => [id, status]),
        ),
      };
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      executor.close();
    },
  };
}

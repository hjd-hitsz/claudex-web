import { answerAcpPermission } from "./acp-permissions.mjs";
import { randomUUID } from "node:crypto";
import {
  acceptDelegation,
  currentResultNotice,
  executing,
} from "./delegation-store.mjs";
import { delegationNotice, noticeMarker } from "./delegation-delivery.mjs";
import {
  delegationHistoryEvent,
  delegationThreadId,
  readDelegationHistory,
} from "./delegation-history.mjs";
import { createExecutors, executorLabel } from "./executors.mjs";
import { createDelegationExecution } from "./delegation-execution.mjs";

const requestMethods = new Set([
  "item/tool/requestUserInput",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
  "lan/agy/permission",
]);

export function createDelegations({
  store,
  getBackend,
  config,
  version,
  emit,
  sessions,
}) {
  const delivery = new Set();
  let timer;
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

  function agyEntry(token) {
    const entry = sessions().tokens.get(token);
    if (!entry) throw new Error("agy 委派连接已过期");
    return entry;
  }

  function taskItem(task) {
    const { id, parentId, target, status, selection } = task;
    const agentId = delegationThreadId(id);
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
        result: task.steps.at(-1).result,
      },
    };
    return item;
  }

  function publish(task) {
    emit({
      method: "item/completed",
      params: {
        threadId: task.parentId,
        turnId: task.parentTurnId,
        item: taskItem(task),
      },
    });
  }

  let plans;
  async function plan() {
    const current = getBackend();
    if (!plans || plans.backend !== current) {
      const { createBackendConfiguration } =
        await import("../configuration.mjs");
      plans = { backend: current, config: createBackendConfiguration(config) };
    }
    const { backends } = await plans.config.read();
    return ["codex", "claude"].filter(
      (id) =>
        current.delegates[id]?.enabled &&
        backends.some((b) => b.id === id && b.enabled),
    );
  }
  function mcpReady({ token }) {
    const entry = agyEntry(token);
    entry.toolsReady = true;
    entry.ready?.();
    return {};
  }
  async function list({ token }) {
    const entry = agyEntry(token);
    const enabled = await plan();
    const { tasks } = await store.read();
    for (const task of Object.values(tasks))
      if (task.parentId === entry.id && !enabled.includes(task.target))
        enabled.push(task.target);
    return enabled;
  }
  async function forwardingContext(parentId, blocks) {
    const { tasks } = await store.read();
    const assignments = Object.values(tasks).filter(
      (task) =>
        task.parentId === parentId &&
        (executing.has(task.status) || task.status === "unknown"),
    );
    if (!assignments.length) return blocks;
    return [
      ...blocks,
      {
        type: "text",
        text: [
          "Claudex 当前会话的委派：",
          ...assignments.map(
            ({ target, id }) => "ask_" + target + " · task_id " + id,
          ),
          "如果用户在这条消息里补充或更改了已有委派的要求，立即调用对应工具并使用原 task_id 转交。执行端会在原生会话接管；无需等待原请求或审批结束。",
        ].join("\n"),
      },
    ];
  }
  async function submit({ token, tool, input }) {
    const entry = agyEntry(token);
    const activity = sessions().active.get(entry.id);
    if (!activity?.ready) throw new Error("当前没有提交委派的 agy 轮次");
    const target = { ask_codex: "codex", ask_claude: "claude" }[tool];
    if (!target) throw new Error("未知委派工具");
    const { input: send, turn, session } = activity;
    const snapshot =
      send.delegateTo === target && (await plan()).includes(target)
        ? getBackend().delegates[target]
        : null;
    const { response, task, obsolete } = await store.change((data) => {
      if (sessions().active.get(entry.id) !== activity || activity.cancelled)
        throw new Error("该 Antigravity 轮次已中断");
      const before = data.tasks[input?.task_id];
      const previous = before?.steps.at(-1).id;
      const request = before?.request;
      const response = acceptDelegation(data, {
        parent: session,
        turn: { ...turn, original: send.original },
        target,
        input,
        snapshot,
      });
      const task = data.tasks[response.task_id];
      return {
        response,
        task,
        obsolete: previous !== task.steps.at(-1).id && request,
      };
    });
    if (obsolete) resolveRequest(task.parentId, obsolete.localId);
    publish(task);
    wake();
    return response;
  }
  async function prepareMcp(entry, activity) {
    if (!activity.input.delegateTo && !activity.input.notice) return;
    if (entry.toolsReady) return;
    const { signal } = activity.controller;
    signal.throwIfAborted();
    let timeout;
    let abort;
    try {
      await new Promise((resolve, reject) => {
        entry.ready = resolve;
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        timeout = setTimeout(
          () => reject(new Error("委派工具仍在连接，请重试当前消息")),
          10000,
        );
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      delete entry.ready;
    }
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
    const p = event.params || {};
    const state = await store.read();
    const task = Object.values(state.tasks).find(
      (task) =>
        task.executor?.runtimeId === entry.runtimeId &&
        task.executor.threadId === p.threadId &&
        executing.has(task.status),
    );
    if (!task) {
      if (event.method === "lan/state" && entry.adapter.ready) wake();
      return;
    }
    const history = delegationHistoryEvent(task, event);
    if (history) emit(history);
    if (event.id !== undefined && requestMethods.has(event.method))
      await recordRequest(task, event);
    if (
      [
        "turn/completed",
        "thread/backgroundTerminals/updated",
        "lan/state",
      ].includes(event.method)
    )
      wake();
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

  async function finishNotice(id, turn) {
    await store.change((data) => {
      const notice = data.notices[id];
      if (notice.status === "submitting")
        notice.status = turn.status === "completed" ? "delivered" : "uncertain";
    });
  }
  async function deliver(notice, state) {
    const session = state.sessions[notice.parentId];
    if (
      !session ||
      session.deleted ||
      session.archived ||
      sessions().busy(session.id) ||
      delivery.has(session.id)
    )
      return;
    delivery.add(session.id);
    try {
      if (notice.status === "submitting") {
        const updates = await sessions().replay(session);
        const history = updates
          .filter((update) => update.sessionUpdate === "user_message_chunk")
          .map((update) => update.content?.text || "")
          .join("");
        await store.change((data) => {
          data.notices[notice.id].status = history.includes(
            noticeMarker(notice.id),
          )
            ? "delivered"
            : "uncertain";
        });
      } else {
        const { prompt, ...record } = delegationNotice(
          notice,
          state.tasks[notice.taskId],
        );
        await sessions().prompt(session, record, { notice: true }, prompt);
      }
    } finally {
      delivery.delete(session.id);
    }
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
    list,
    forwardingContext,
    mcpReady,
    submit,
    acpRequest: answerAcpPermission,
    prepareMcp,
    respond,
    cancel: runner.cancel,
    wake,
    finishNotice,
    project: taskItem,
    history: (method, params) =>
      readDelegationHistory(store, executor, method, params),
    async snapshot() {
      const state = await store.read();
      const tasks = Object.values(state.tasks);
      return {
        questions: tasks.filter(({ request }) => request).map(externalRequest),
        pending: Object.fromEntries(
          tasks
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

import { readPromptSections, renderPrompt } from "../../prompts.mjs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  resourceId,
  resourceTarget,
} from "../../../../shared/backend-identity.mjs";
import { runtimeIdentity } from "../../conversation-manager/address.mjs";
import {
  claudeDelegationToolName,
  delegationToolName,
  delegationStepToolName,
} from "../../conversation-manager/tools.mjs";
import { createStorage } from "../storage.mjs";
import {
  acceptDelegation,
  currentResultNotice,
  executing,
} from "./delegation-store.mjs";
import { noticeResult } from "./call-chain.mjs";
import { executorLabel } from "./executors.mjs";
import { createDelegationRuntime } from "./runtime.mjs";
import {
  buildDelegationSelection,
  delegationBackends,
  resolveSourcePrompt,
} from "./settings.mjs";

const workflow = readPromptSections("delegation/workflow.md");
const dispatch = workflow("nativeDispatch");
const followUp = workflow("nativeFollowUp");

const peerBackend = (id) => (id === "codex" ? "claude" : "codex");
const idleSnapshot = { questions: [], pending: {} };

export function createNativeDelegation({
  config,
  version,
  emit,
  changed,
  backendEntry,
}) {
  const storage = createStorage(
    join(config.configDir, "delegation", "state.json"),
    {
      tasks: {},
      notices: {},
      receipts: {},
    },
  );
  const store = {
    ...storage,
    async change(change) {
      let result;
      await storage.update((data) => {
        result = change(data);
        return data;
      });
      return result;
    },
  };
  const grants = new Map();
  const delivery = new Set();
  let snapshot = idleSnapshot;
  let revision = 0;
  let stopped = false;
  const runtime = createDelegationRuntime({
    store,
    config,
    version,
    emit,
    deliver,
    resourceThreadId: (task, id) =>
      resourceId(resourceTarget(task.parentId).backendId, id),
    changed: () => refresh().catch(console.error),
  });

  async function refresh() {
    const reading = ++revision;
    const next = await runtime.snapshot();
    if (stopped || reading !== revision) return;
    snapshot = next;
    changed();
  }

  async function prepare(entry, params) {
    const source = entry.backend;
    const target = peerBackend(source.id);
    const executor = backendEntry(target);
    const settings = backendEntry("agy").backend;
    if (!executor?.backend.enabled || !settings.delegates[target]?.enabled)
      throw new Error("请为目标后端开启接收委派");
    const codex = source.id === "codex" ? source : executor.backend;
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(codex.url).hostname)
    )
      throw new Error("双向委派需要共享本机工作区的 Codex app-server");
    const id = resourceId(source.id, params.threadId);
    if (
      grants.has(id) ||
      entry.adapter.state().params.activeTurns?.[params.threadId]
    )
      throw new Error("请等待当前轮次结束后提交新的委派");
    const parent = await entry.adapter.conversationManager?.readThread(
      params.threadId,
    );
    if (!parent?.cwd) throw new Error("找不到委派发起会话的工作目录");
    const { tasks } = await store.read();
    const sourcePrompt = await resolveSourcePrompt(settings, source.id);
    if (grants.has(id)) throw new Error("委派轮次正在提交");
    const grant = {
      token: randomUUID(),
      input: params.input,
      selection: buildDelegationSelection(settings, target),
      sourceRuntime: runtimeIdentity(source),
      cwd: parent.cwd,
      sourceName: source.name,
      target,
      id,
    };
    const active = Object.values(tasks).filter(
      (task) =>
        task.parentId === id &&
        task.sourceRuntime === grant.sourceRuntime &&
        (executing.has(task.status) || task.status === "unknown"),
    );
    const instructions = [
      renderPrompt(dispatch, {
        backend: executor.backend.name,
        tool:
          source.id === "claude"
            ? claudeDelegationToolName
            : delegationToolName,
        token: grant.token,
      }),
      sourcePrompt,
      ...active.map(({ id }) => renderPrompt(followUp, { id })),
    ].join("\n");
    grants.set(id, grant);
    return {
      grant,
      params:
        source.id === "codex"
          ? {
              ...params,
              additionalContext: {
                ...params.additionalContext,
                claudex_delegation: {
                  kind: "application",
                  value: instructions,
                },
              },
            }
          : { ...params, delegationContext: instructions },
    };
  }

  function observe(entry, event) {
    if (
      !["turn/started", "turn/completed", "thread/closed"].includes(
        event.method,
      )
    )
      return;
    const { threadId, turn } = event.params;
    const id = resourceId(entry.backend.id, threadId);
    const grant = grants.get(id);
    if (!grant) return;
    if (event.method === "turn/started") {
      if (!grant.turnId) grant.turnId = turn.id;
      else if (grant.turnId !== turn.id) grants.delete(id);
    } else if (event.method === "thread/closed" || grant.turnId === turn?.id) {
      grants.delete(id);
    }
  }

  function settle(grant, response) {
    if (!grant || grants.get(grant.id) !== grant) return;
    if (response.error) grants.delete(grant.id);
    else grant.turnId ??= response.result?.turn?.id;
  }

  async function submit(source, actor, input) {
    const id = resourceId(source.id, actor.threadId);
    const grant = grants.get(id);
    if (
      !grant ||
      input?.token !== grant.token ||
      grant.sourceRuntime !== runtimeIdentity(source)
    )
      throw new Error("请在当前会话的输入框开启委派模式后提交");
    const entry = backendEntry(source.id);
    const active = () =>
      entry.adapter.state().params.activeTurns?.[actor.threadId];
    const turnId = grant.turnId ?? active();
    if (!turnId || active() !== turnId)
      throw new Error("委派请求须来自当前执行中的轮次");
    const { token, ...request } = input;
    const { response, task, obsolete } = await store.change((data) => {
      if (grants.get(id) !== grant || active() !== turnId)
        throw new Error("委派发起轮次已结束");
      const previous = Object.hasOwn(data.tasks, request.task_id)
        ? data.tasks[request.task_id]
        : null;
      if (previous && previous.sourceRuntime !== grant.sourceRuntime)
        throw new Error("委派发起后端实例已更换");
      const step = previous?.steps.at(-1);
      const pending = previous?.request;
      const settings = backendEntry("agy").backend;
      const targetEnabled =
        backendEntry(grant.target)?.backend.enabled &&
        settings.delegates[grant.target]?.enabled;
      const response = acceptDelegation(data, {
        parent: {
          id,
          cwd: grant.cwd,
          sourceName: grant.sourceName,
          sourceRuntime: grant.sourceRuntime,
        },
        turn: { id: turnId, original: grant.input },
        target: grant.target,
        input: request,
        snapshot: targetEnabled ? grant.selection : null,
      });
      const task = data.tasks[response.task_id];
      return {
        response,
        task,
        obsolete: step && step !== task.steps.at(-1) && pending,
      };
    });
    if (obsolete) runtime.resolveRequest(id, obsolete.localId);
    runtime.publish(task);
    runtime.wake();
    return response;
  }

  async function deliver(notice, { tasks }) {
    const { backendId, nativeId } = resourceTarget(notice.parentId);
    const entry = backendEntry(backendId);
    const task = tasks[notice.taskId];
    if (
      !entry?.adapter?.ready ||
      entry.changing ||
      runtimeIdentity(entry.backend) !== task.sourceRuntime ||
      delivery.has(notice.parentId)
    )
      return;
    delivery.add(notice.parentId);
    try {
      const adapter = entry.adapter.conversationManager;
      const to = await adapter.readThread(nativeId);
      if (!to) return;
      const claiming = notice.status === "queued";
      // Codex checks the exact submitted text when reconciling a receipt.
      const payload = claiming ? noticeResult(notice, task) : notice.payload;
      const envelope = {
        id: notice.stepId,
        replyTo: null,
        delegation: true,
        from: {
          threadId: task.executor?.threadId,
          title: executorLabel(task.target),
        },
        to,
        body: JSON.stringify({ task_id: task.id, ...payload }),
      };
      if (claiming) {
        const claimed = await store.change((data) => {
          const item = data.notices[notice.id];
          if (item.status !== "queued" || !currentResultNotice(data, item))
            return false;
          item.payload = payload;
          item.status = "submitting";
          return true;
        });
        if (!claimed) return;
      }
      const outcome = await (claiming
        ? adapter.deliver(envelope)
        : adapter.reconcile(envelope));
      const status =
        { deferred: "queued", delivered: "delivered", failed: "failed" }[
          outcome.status
        ] || "submitting";
      if (status === "submitting") return;
      await store.change((data) => {
        const item = data.notices[notice.id];
        if (item.status === "submitting") item.status = status;
      });
    } finally {
      delivery.delete(notice.parentId);
    }
  }

  return {
    prepare,
    observe,
    settle,
    submit,
    invoke: (source, name, actor, input) =>
      name === delegationStepToolName
        ? runtime.readStep(
            {
              id: resourceId(source.id, actor.threadId),
              runtimeId: runtimeIdentity(source),
            },
            input,
          )
        : submit(source, actor, input),
    ...runtime,
    snapshot: () => snapshot,
    async tasks(threadId) {
      const { backendId } = resourceTarget(threadId);
      if (!delegationBackends.includes(backendId)) return { items: [] };
      const source = backendEntry(backendId)?.backend;
      if (!source) return { items: [] };
      const { tasks } = await store.read();
      return {
        items: Object.values(tasks)
          .filter(
            (task) =>
              task.parentId === threadId &&
              task.sourceRuntime === runtimeIdentity(source),
          )
          .map((task) => ({
            ...runtime.project(task),
            turnId: task.parentTurnId,
          })),
      };
    },
    async start() {
      await refresh();
      runtime.wake();
    },
    close() {
      stopped = true;
      grants.clear();
      runtime.close();
    },
  };
}

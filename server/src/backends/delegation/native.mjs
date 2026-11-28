import {
  resourceId,
  resourceTarget,
} from "../../../../shared/backend-identity.mjs";
import { runtimeIdentity } from "../../conversation-manager/address.mjs";
import { delegationStepToolName } from "../../conversation-manager/tools.mjs";
import { createStorage } from "../storage.mjs";
import { acceptDelegation, currentResultNotice } from "./delegation-store.mjs";
import { noticeResult } from "./call-chain.mjs";
import { findDelegationTask, traceId } from "./trace-ids.mjs";
import { executorLabel } from "./executors.mjs";
import { createDelegationRuntime } from "./runtime.mjs";
import { nativeDelegationStatePath } from "./activity.mjs";
import { buildDelegationSelection, delegationBackends } from "./settings.mjs";

const peerBackend = (id) => (id === "codex" ? "claude" : "codex");
const idleSnapshot = { questions: [], pending: {} };

export function createNativeDelegation({
  config,
  version,
  emit,
  changed,
  backendEntry,
  modes,
}) {
  const storage = createStorage(nativeDelegationStatePath(config.configDir), {
    tasks: {},
    notices: {},
    receipts: {},
  });
  const store = {
    ...storage,
    async change(change) {
      let result;
      await storage.update(async (data) => {
        result = await change(data);
        return data;
      });
      return result;
    },
  };
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

  async function submit(source, actor, request) {
    const id = resourceId(source.id, actor.threadId);
    const entry = backendEntry(source.id);
    const sourceRuntime = runtimeIdentity(source);
    const connected = () =>
      !stopped &&
      entry === backendEntry(source.id) &&
      !entry?.changing &&
      entry?.adapter?.ready;
    const { turnId } = actor;
    // Native MCP can reach the bridge before Codex publishes turn/started.
    if (
      !connected() ||
      typeof turnId !== "string" ||
      !turnId ||
      (source.id === "codex" &&
        (typeof actor.callId !== "string" || !actor.callId))
    )
      throw new Error("委派请求须来自当前执行中的原生轮次");
    const target = peerBackend(source.id);
    const executor = backendEntry(target)?.backend;
    const codex = source.id === "codex" ? source : executor;
    if (
      !codex ||
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(codex.url).hostname)
    )
      throw new Error("双向委派需要共享本机工作区的 Codex app-server");
    const parent = await entry.adapter.conversationManager.readThread(
      actor.threadId,
    );
    if (!parent?.cwd) throw new Error("找不到委派发起会话的工作目录");
    const { response, task, obsolete } = await store.change(async (data) => {
      if (!connected()) throw new Error("委派发起后端连接已变更");
      const authorized =
        source.id === "claude"
          ? parent.delegationTurnId === turnId
          : await modes.codexEnabledForResume(source, actor.threadId);
      if (!authorized) throw new Error("请先为当前对话开启委派模式。");
      const previous = findDelegationTask(
        data.tasks,
        { id, runtimeId: sourceRuntime },
        request.task_id,
      );
      const step = previous?.steps.at(-1);
      const pending = previous?.request;
      const settings = backendEntry("agy").backend;
      const targetEnabled =
        backendEntry(target)?.backend.enabled &&
        settings.delegates[target]?.enabled;
      const response = acceptDelegation(data, {
        parent: {
          id,
          cwd: parent.cwd,
          sourceName: source.name,
          sourceRuntime,
        },
        turn: { id: turnId },
        target,
        callId: actor.callId,
        input: request,
        snapshot: targetEnabled
          ? buildDelegationSelection(settings, target)
          : null,
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
    return { ...response, task_id: traceId(response.task_id) };
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
      const wireId = claiming ? traceId(task.id) : (notice.wireId ?? task.id);
      const envelope = {
        id: notice.stepId,
        ...((claiming || notice.wireId) && {
          displayId: traceId(notice.stepId),
        }),
        replyTo: null,
        delegation: true,
        from: {
          threadId: task.executor?.threadId,
          title: executorLabel(task.target),
        },
        to,
        body: JSON.stringify({ task_id: wireId, ...payload }),
      };
      if (claiming) {
        const claimed = await store.change((data) => {
          const item = data.notices[notice.id];
          if (item.status !== "queued" || !currentResultNotice(data, item))
            return false;
          item.payload = payload;
          item.wireId = wireId;
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
      runtime.close();
    },
  };
}

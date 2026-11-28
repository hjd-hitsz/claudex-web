import { readPromptSections, renderPrompt } from "../../prompts.mjs";
import { delegationStepToolName } from "../../conversation-manager/tools.mjs";
import { answerAcpPermission } from "./acp-permissions.mjs";
import {
  acceptDelegation,
  executing,
} from "../delegation/delegation-store.mjs";
import { buildDelegationSelection } from "../delegation/settings.mjs";
import { createDelegationRuntime } from "../delegation/runtime.mjs";
import { findDelegationTask, traceId } from "../delegation/trace-ids.mjs";
import { delegationNotice, noticeMarker } from "./delegation-delivery.mjs";
import {
  archivedToolOutput,
  readArchivedToolOutput,
} from "./archived-tool-output.mjs";

const forwarding = readPromptSections("delegation/workflow.md")(
  "secretaryForwarding",
);

export function createDelegations({
  store,
  getBackend,
  config,
  version,
  emit,
  sessions,
}) {
  const delivery = new Set();
  const runtime = createDelegationRuntime({
    store,
    config,
    version,
    emit,
    deliver,
    validateParent: store.session,
  });
  function agyEntry(token) {
    const entry = sessions().tokens.get(token);
    if (!entry) throw new Error("agy 委派连接已过期");
    return entry;
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
    entry.mcpTools = [
      ...enabled.map((target) => "ask_" + target),
      delegationStepToolName,
      archivedToolOutput.name,
    ];
    return [...enabled, delegationStepToolName, archivedToolOutput.name];
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
        text: renderPrompt(forwarding, {
          assignments: assignments
            .map(
              ({ target, id }) => "ask_" + target + " · task_id " + traceId(id),
            )
            .join("\n"),
        }),
      },
    ];
  }
  async function invoke({ token, tool, input }) {
    const entry = agyEntry(token);
    const activity = sessions().active.get(entry.id);
    if (!activity?.submitted || activity.entry !== entry)
      throw new Error("当前没有提交委派的 agy 轮次");
    if (tool === delegationStepToolName)
      return runtime.readStep({ id: entry.id }, input);
    if (tool === archivedToolOutput.name)
      return readArchivedToolOutput(
        store,
        entry.id,
        input,
        sessions().agentInfo(),
      );
    const target = { ask_codex: "codex", ask_claude: "claude" }[tool];
    if (!target) throw new Error("未知委派工具");
    const { input: send, turn, session } = activity;
    const snapshot =
      send.delegateTo === target && (await plan()).includes(target)
        ? buildDelegationSelection(getBackend(), target)
        : null;
    const { response, task, obsolete } = await store.change((data) => {
      if (
        sessions().active.get(entry.id) !== activity ||
        sessions().entries.get(entry.id) !== entry ||
        !activity.submitted ||
        activity.cancelled
      )
        throw new Error("该 Antigravity 轮次已中断");
      const before = findDelegationTask(data.tasks, session, input?.task_id);
      if (
        before?.parentId === entry.id &&
        !session.turns.some(
          ({ id }) => id === before.steps.at(-1).parentTurnId,
        ) &&
        turn.id !== before.steps.at(-1).parentTurnId
      )
        throw new Error("此委派步骤所属轮次已移出当前历史");
      const previous = before?.steps.at(-1).id;
      const request = before?.request;
      const response = acceptDelegation(data, {
        parent: session,
        turn: { id: turn.id },
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
    if (obsolete) runtime.resolveRequest(task.parentId, obsolete.localId);
    runtime.publish(task);
    runtime.wake();
    return { ...response, task_id: traceId(response.task_id) };
  }
  async function prepareMcp(entry, activity) {
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
          data.notices[notice.id].status = [
            noticeMarker(notice.id),
            noticeMarker(notice.id, true),
          ].some((marker) => history.includes(marker))
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

  return {
    ...runtime,
    list,
    forwardingContext,
    mcpReady,
    invoke,
    acpRequest: answerAcpPermission,
    prepareMcp,
    finishNotice,
    delivering: (id) => delivery.has(id),
  };
}

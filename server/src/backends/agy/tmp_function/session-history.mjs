// ACP 缺口：按轮次分叉与编辑重发需要原生历史分叉或回退。
// 探测证据：agy 1.5.18 的 session/fork、session/fork_at、session/rewind、
// session/revert、session/rollback 均返回 -32601 Method not found。
// 切换条件：原生分叉可返回新会话标识，或原生回退方法可更新历史并发出变更事件。
// 登记见 docs/future_plan.md#缺口登记。
import { randomUUID } from "node:crypto";
import { readPromptSections, renderPrompt } from "../../../prompts.mjs";
import {
  executing,
  currentResultNotice,
} from "../../delegation/delegation-store.mjs";
import { visibleAgyItems } from "../acp-messages.mjs";
import { nowSeconds } from "../session-store.mjs";

const workflow = readPromptSections("delegation/workflow.md");
const summarize = (value, limit = 4000) => {
  if (value == null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > limit ? text.slice(0, limit).toWellFormed() + "…" : text;
};

export function retainedAgyTurns(turns, turnId, inclusive) {
  if (inclusive && !turnId) return turns.slice();
  const index = turns.findIndex(({ id }) => id === turnId);
  if (index < 0) throw new Error("找不到指定的 agy 历史轮次");
  return turns.slice(0, index + Number(inclusive));
}

export function agyHistoryRecords(turns) {
  const seenResults = new Set();
  return turns
    .map(({ items }) =>
      visibleAgyItems(items).flatMap((item) => {
        const { type } = item;
        if (!item.origin && type === "userMessage")
          return [
            {
              type,
              content: item.content.map(({ type, text, path }) => ({
                type,
                text,
                path,
              })),
            },
          ];
        if (!item.origin && type === "agentMessage")
          return [{ type, text: item.text }];
        if (
          type === "mcpToolCall" &&
          ["completed", "failed"].includes(item.status)
        ) {
          const result = summarize(item.result ?? item.error);
          const archived = item.id && result?.length > 1024;
          return [
            {
              type,
              tool: item.nativeTool || item.tool,
              status: item.status,
              arguments: summarize(item.arguments),
              result: archived ? summarize(result, 256) : result,
              ...(archived && { archivedCallId: item.id }),
            },
          ];
        }
        if (type === "delegationResult") {
          const key =
            item.taskId &&
            item.stepId &&
            JSON.stringify([item.taskId, item.stepId, item.status]);
          if (key && seenResults.has(key)) return [];
          if (key) seenResults.add(key);
          return [
            {
              type,
              target: item.target,
              status: item.status,
              taskId: item.taskId,
              stepId: item.stepId,
              result: summarize(item.context),
            },
          ];
        }
        if (type === "fileChange" && item.status === "completed")
          return [
            {
              type,
              changes: item.changes.map(({ path, kind }) => ({ path, kind })),
            },
          ];
        return [];
      }),
    )
    .filter((items) => items.length);
}

export function agyHistoryPrompt(session) {
  const replay = session.historyReplay;
  let history;
  if (replay?.nativeId && replay.nativeId === session.nativeId) {
    const turns = retainedAgyTurns(session.turns, replay.throughTurnId, true);
    history = agyHistoryRecords(turns);
  } else if (session.source?.context && !session.turns.length) {
    // Older forks saved continuation text instead of retaining their prefix turns.
    history = session.source.context;
  }
  if (!history?.length) return;
  return {
    type: "text",
    text:
      renderPrompt(workflow("secretaryHistoryReplay"), {
        history: JSON.stringify(history).replaceAll("<", "\\u003c"),
      }) + "\n\n",
  };
}

export function assertAgyHistoryIdle(data, session, occupancy) {
  const { id, turns } = session;
  if (occupancy.compacting) throw new Error("正在整理上下文，请等待整理完成");
  if (occupancy.pending) throw new Error("此对话有排队输入，请等待发送完成");
  if (occupancy.active || turns.some(({ status }) => status === "inProgress"))
    throw new Error("请先等待 agy 轮次结束");
  if (occupancy.undoing) throw new Error("正在撤销文件修改，请等待完成");
  if (
    Object.values(data.tasks).some(
      (task) => task.parentId === id && executing.has(task.status),
    )
  )
    throw new Error("请先等待或停止此对话的委派任务");
  if (
    occupancy.delivering ||
    Object.values(data.notices).some(
      (notice) =>
        notice.parentId === id &&
        ["queued", "submitting"].includes(notice.status) &&
        currentResultNotice(data, notice),
    )
  )
    throw new Error("请等待此对话的委派结果回投完成");
}

function withNativeHistory(session, nativeId, turns) {
  const next = { ...session, turns, nativeId, updatedAt: nowSeconds() };
  delete next.tokenUsage;
  delete next.contextCheckpoint;
  delete next.nativeContextPending;
  delete next.historyReplay;
  if (turns.length)
    next.historyReplay = { nativeId, throughTurnId: turns.at(-1).id };
  return next;
}

export function createAgyHistoryActions({
  store,
  occupancy,
  prepare,
  toolResults = () => {},
  discard,
  changed,
  wake,
  rewriting,
}) {
  return async function historyAction(method, id, params) {
    if (rewriting.has(id)) throw new Error("正在更新 agy 对话历史，请稍后重试");
    rewriting.add(id);
    let candidate;
    let committed = false;
    try {
      const data = await store.read();
      const session = store.session(data, id);
      assertAgyHistoryIdle(data, session, occupancy(id));
      const fork = method === "thread/fork";
      if (!fork && session.archived) throw new Error("请恢复归档后再编辑");
      const turnId = fork
        ? params.lastTurnId || params.turnId || params.fromTurnId
        : params.beforeTurnId;
      const turns = retainedAgyTurns(session.turns, turnId, fork);
      toolResults(turns, [session.nativeId, session.previousNativeId]);
      if (
        !fork &&
        params.beforeItemId &&
        session.turns[turns.length].items.find(
          ({ type }) => type === "userMessage",
        )?.id !== params.beforeItemId
      )
        throw new Error("找不到要编辑的 agy 轮次首条消息");
      if (
        "expectedLastTurnId" in params &&
        (session.turns.at(-1)?.id ?? null) !== params.expectedLastTurnId
      )
        throw new Error("对话已有新消息，请重新打开对话后编辑");
      candidate = fork
        ? {
            id: randomUUID(),
            cwd: session.cwd,
            name: "从历史继续",
            model: params.model || session.model,
            effort: params.config?.model_reasoning_effort || session.effort,
            threadSource: params.threadSource || session.threadSource,
            createdAt: nowSeconds(),
            source: {
              threadId: id,
              turnId,
              ...(!turns.length &&
                session.source?.context && { context: session.source.context }),
            },
          }
        : { ...session, nativeId: undefined };
      if (!fork) discard(id);
      const { nativeId, config } = await prepare(candidate);
      const next = withNativeHistory(candidate, nativeId, turns);
      next.model = config.model || next.model;
      next.effort = config.effort || next.effort;
      if (!fork) next.previousNativeId = session.nativeId;
      await store.change((current) => {
        const saved = store.session(current, id);
        assertAgyHistoryIdle(current, saved, occupancy(id));
        if (
          saved.nativeId !== session.nativeId ||
          saved.turns.at(-1)?.id !== session.turns.at(-1)?.id
        )
          throw new Error("agy 对话历史已变化，请重新打开后重试");
        current.sessions[next.id] = next;
      });
      committed = true;
      changed(next, fork);
      return next;
    } finally {
      if (!committed && candidate) discard(candidate.id);
      rewriting.delete(id);
      wake();
    }
  };
}

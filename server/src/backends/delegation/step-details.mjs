import { readClaudeToolRecords } from "../claude/tool-records.mjs";
import { readRolloutTools } from "../codex/rollout-tools.mjs";
import {
  conversationArguments,
  delegationStepToolName,
} from "../../conversation-manager/tools.mjs";
import { initialTurn } from "./delegation-results.mjs";
import { turnCalls } from "./call-chain.mjs";

const pageSize = 4000;

function detailPage(detail, offset) {
  const json = JSON.stringify(detail);
  if (offset === undefined && json.length <= pageSize) return detail;
  const start = offset ?? 0;
  if (start >= json.length || /[\uDC00-\uDFFF]/.test(json[start]))
    throw new Error("委派详情分页位置无效");
  let end = Math.min(start + pageSize, json.length);
  if (end < json.length && /[\uDC00-\uDFFF]/.test(json[end])) end--;
  return {
    encoding: "json",
    chunk: json.slice(start, end),
    nextOffset: end < json.length ? end : null,
  };
}

export async function readDelegationStep(store, executor, parent, input) {
  const { taskId, stepId, callId, turnId, offset } = conversationArguments(
    delegationStepToolName,
    input,
  );
  const { tasks } = await store.read();
  const task = Object.hasOwn(tasks, taskId) && tasks[taskId];
  if (
    !task ||
    task.parentId !== parent.id ||
    task.sourceRuntime !== parent.runtimeId
  )
    throw new Error("当前会话找不到该委派任务");
  const step = task.steps.find(({ id }) => id === stepId);
  if (!step) throw new Error("委派任务中找不到该步骤");
  const identity = { taskId, stepId, backend: task.target };
  if (!callId && (step.result?.callChain || !task.executor))
    return detailPage(
      { ...identity, request: step.request, result: step.result },
      offset,
    );
  if (!task.executor) throw new Error("委派步骤尚无原生执行记录");

  const entry = await executor.resolve(task);
  const { thread } = await executor.readHistory(entry, "thread/read", {
    threadId: task.executor.threadId,
    includeTurns: true,
  });
  const initial = initialTurn(thread.turns ?? [], step);
  const ids = new Set(
    [
      initial?.id,
      ...(step.result?.turns?.map(({ turnId }) => turnId) ??
        step.turnIds ??
        []),
    ].filter(Boolean),
  );
  const turns = (thread.turns ?? []).filter((turn) => ids.has(turn.id));
  const rollout =
    task.target === "codex"
      ? await readRolloutTools(thread, ids, callId)
      : new Map();
  const chain = turns.flatMap((turn) =>
    turnCalls(turn, rollout.get(turn.id), task.target),
  );
  if (!callId)
    return detailPage(
      {
        ...identity,
        request: step.request,
        result: { ...step.result, callChain: chain },
      },
      offset,
    );

  const matches = chain.filter(
    (call) => call.callId === callId && (!turnId || call.turnId === turnId),
  );
  if (matches.length > 1) throw new Error("请提供调用链中的 turnId");
  const call = matches[0];
  if (!call) throw new Error("该委派步骤中找不到指定调用");
  const items = turns.find(({ id }) => id === call.turnId).items;
  const item = items?.find(({ id }) => id === callId);
  const raw =
    task.target === "codex"
      ? rollout.get(call.turnId)?.get(callId)
      : await readClaudeToolRecords(entry.backend, thread, item);
  return detailPage(
    {
      ...identity,
      call,
      item,
      ...(task.target === "claude" && {
        changes: items?.find(({ id }) => id === "file-" + callId)?.changes,
      }),
      raw,
    },
    offset,
  );
}

import { readClaudeToolRecords } from "../claude/tool-records.mjs";
import { readRolloutTrace } from "../codex/rollout-tools.mjs";
import {
  conversationArguments,
  delegationStepToolName,
} from "../../conversation-manager/tools.mjs";
import {
  delegationStage,
  initialTurn,
  summarizeDelegationStages,
  traceVersion,
} from "./delegation-results.mjs";
import { resultNoticePayload, traceCall, turnCalls } from "./call-chain.mjs";
import { findDelegationTask, traceId, traceMatches } from "./trace-ids.mjs";
import { delegationContext } from "./context.mjs";

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
  const task = findDelegationTask(tasks, parent, taskId);
  if (!task) throw new Error("当前会话找不到该委派任务");
  const steps = traceMatches(task.steps, stepId, (step) => step.id);
  if (steps.length > 1) throw new Error("步骤短 ID 有重复，请提供完整步骤 ID");
  const [step] = steps;
  if (!step) throw new Error("委派任务中找不到该步骤");
  const identity = {
    taskId: traceId(task.id),
    stepId: traceId(step.id),
    backend: task.target,
  };
  if (!callId && (step.result?.traceVersion === traceVersion || !task.executor))
    return detailPage(
      {
        ...identity,
        request: step.request,
        result: step.result && resultNoticePayload(step.result),
      },
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
  const turns = (thread.turns ?? []).filter(
    (turn) => ids.has(turn.id) && (!callId || !turnId || turn.id === turnId),
  );
  const rollout =
    task.target === "codex"
      ? await readRolloutTrace(
          thread,
          new Set(turns.map(({ id }) => id)),
          callId && ((id) => id === callId || traceId(id) === callId),
        )
      : new Map();
  if (!callId) {
    const summaries = new Map(
      step.result?.turns?.map((turn) => [turn.turnId, turn]),
    );
    const stages = turns.map((turn) =>
      delegationStage(
        turn,
        summaries.get(turn.id)?.triggers ?? [],
        task.target,
        rollout.get(turn.id),
      ),
    );
    const last = turns.at(-1)?.id;
    const context =
      last && delegationContext(thread, last, rollout.get(last)?.context);
    return detailPage(
      {
        ...identity,
        request: step.request,
        result: resultNoticePayload({
          ...step.result,
          ...(stages.length && summarizeDelegationStages(stages)),
          ...(context && { context }),
        }),
      },
      offset,
    );
  }

  const chain = turns.flatMap((turn) =>
    turnCalls(turn, rollout.get(turn.id), task.target).map((call) => ({
      call,
      turn,
    })),
  );
  const matches = traceMatches(chain, callId, ({ call }) => call.callId);
  if (matches.length > 1)
    throw new Error("调用 ID 有重复，请提供所属 turnId 或完整调用 ID");
  const [match] = matches;
  if (!match) throw new Error("该委派步骤中找不到指定调用");
  const { call, turn } = match;
  const nativeCallId = call.callId;
  const items = turn.items;
  const trace = rollout.get(turn.id);
  const item =
    items?.find(({ id }) => id === nativeCallId) ??
    trace?.items.get(nativeCallId);
  const raw =
    task.target === "codex"
      ? trace?.calls.get(nativeCallId)
      : await readClaudeToolRecords(entry.backend, thread, item);
  return detailPage(
    {
      ...identity,
      call: traceCall(call),
      turnId: turn.id,
      item,
      ...(task.target === "claude" && {
        changes: items?.find(({ id }) => id === "file-" + nativeCallId)
          ?.changes,
      }),
      raw,
    },
    offset,
  );
}

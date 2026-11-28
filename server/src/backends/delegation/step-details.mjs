import { createClaudeToolRecordsReader } from "../claude/tool-records.mjs";
import { readRolloutTrace } from "../codex/rollout-tools.mjs";
import {
  conversationArguments,
  delegationStepToolName,
} from "../../conversation-manager/tools.mjs";
import { initialTurn, traceVersion } from "./delegation-results.mjs";
import { traceCall, turnCalls } from "./call-chain.mjs";
import { findDelegationTask, traceId, traceMatches } from "./trace-ids.mjs";
import { deliveryAnswer } from "./delivery-summary.mjs";
import { evidencePage } from "./evidence-page.mjs";

const callsPerPage = 12;

function callsPage(identity, calls, offset = 0) {
  const end = offset + callsPerPage;
  return {
    ...identity,
    calls: calls.slice(offset, end).map(traceCall),
    nextOffset: end < calls.length ? end : null,
  };
}

export async function readDelegationStep(store, executor, parent, input) {
  const { taskId, stepId, callId, filter, callIds, filters, answer, offset } =
    conversationArguments(delegationStepToolName, input);
  const batch = callIds !== undefined || filters !== undefined;
  const requested = [...new Set([callId, ...(callIds ?? [])].filter(Boolean))];
  const keywords = [
    ...new Set(
      [filter, ...(filters ?? [])]
        .filter(Boolean)
        .map((value) => value.trim().toLowerCase()),
    ),
  ];
  const wantsCalls = !requested.length || (batch && keywords.length > 0);
  if (batch && !wantsCalls && offset !== undefined)
    throw new Error("请使用单个 callId 继续读取原始详情");
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
  if (answer) {
    if (requested.length || keywords.length)
      throw new Error("读取步骤答复时请单独传入 answer");
    if (!step.result) throw new Error("该委派步骤尚无存档答复");
    const result = step.result;
    return evidencePage(
      {
        ...identity,
        answer: result.answer ?? deliveryAnswer(result),
        conclusion: result.conclusion,
        error: result.error,
      },
      offset,
    );
  }
  if (!requested.length && !task.executor)
    return callsPage(identity, [], offset);
  if (
    !requested.length &&
    !keywords.length &&
    step.result?.traceVersion === traceVersion
  )
    return callsPage(identity, step.result.callChain, offset);
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
  const wanted = (id) =>
    requested.includes(id) || requested.includes(traceId(id));
  const rollout =
    task.target === "codex"
      ? await readRolloutTrace(
          thread,
          new Set(turns.map(({ id }) => id)),
          !wantsCalls && wanted,
          {
            callsOnly: true,
            ...(requested.length && { outputMatches: wanted }),
          },
        )
      : new Map();
  let page;
  if (wantsCalls) {
    const calls = turns.flatMap((turn) =>
      turnCalls(turn, rollout.get(turn.id), task.target, keywords),
    );
    page = callsPage(identity, calls, offset);
    if (!requested.length) return page;
  }

  const chain = turns.flatMap((turn) =>
    turnCalls(turn, rollout.get(turn.id), task.target).map((call) => ({
      call,
      turn,
    })),
  );
  const readClaudeRecords =
    task.target === "claude" &&
    createClaudeToolRecordsReader(entry.backend, thread);

  async function lookup(id) {
    const matches = traceMatches(chain, id, ({ call }) => call.callId);
    const error =
      matches.length > 1
        ? "调用 ID 有重复，请提供列表中的完整调用 ID"
        : matches.length === 0
          ? "该委派步骤中找不到指定调用"
          : null;
    if (error) {
      if (batch) return { callId: id, error };
      throw new Error(error);
    }
    const [{ call, turn }] = matches;
    const nativeCallId = call.callId;
    const items = turn.items;
    const trace = rollout.get(turn.id);
    const item =
      items?.find(({ id }) => id === nativeCallId) ??
      trace?.items.get(nativeCallId);
    const raw = readClaudeRecords
      ? await readClaudeRecords(item)
      : trace?.calls.get(nativeCallId);
    const detail = {
      ...identity,
      call: traceCall(call),
      turnId: turn.id,
      item,
      ...(task.target === "claude" && {
        changes: items?.find(({ id }) => id === "file-" + nativeCallId)
          ?.changes,
      }),
      raw,
    };
    const result = evidencePage(detail, batch ? undefined : offset);
    return batch ? { callId: id, ...result } : result;
  }

  if (!batch) return lookup(requested[0]);
  const details = await Promise.all(requested.map(lookup));
  return { ...(page ?? identity), details };
}

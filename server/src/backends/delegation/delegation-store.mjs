import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { resultNoticePayload } from "./call-chain.mjs";
import { findDelegationTask } from "./trace-ids.mjs";

export const executing = new Set([
  "accepted",
  "starting",
  "running",
  "waiting",
]);
export const terminal = new Set([
  "completed",
  "failed",
  "interrupted",
  "unknown",
]);
const fields = new Set([
  "request",
  "request_id",
  "task_id",
  "scope",
  "taskSummary",
]);

export function acceptDelegation(
  data,
  { parent, turn, target, input, snapshot, callId },
) {
  if (
    !input ||
    Object.keys(input).some((key) => !fields.has(key)) ||
    typeof input.request !== "string" ||
    !input.request.trim() ||
    input.request.length > 100000 ||
    typeof input.request_id !== "string" ||
    !/^[\w.-]{1,128}$/.test(input.request_id) ||
    (input.scope !== undefined &&
      !["research", "implementation"].includes(input.scope)) ||
    (input.task_id !== undefined && typeof input.task_id !== "string") ||
    (input.taskSummary !== undefined &&
      (typeof input.taskSummary !== "string" ||
        !input.taskSummary.trim() ||
        input.taskSummary.length > 80))
  )
    throw new Error("委派要求、请求标识或任务范围无效");
  const key = JSON.stringify([parent.id, input.request_id]);
  const callKey =
    callId &&
    JSON.stringify([parent.id, parent.sourceRuntime, turn.id, callId]);
  const previous = (callKey && data.receipts[callKey]) || data.receipts[key];
  if (previous) {
    if (previous.target !== target || !isDeepStrictEqual(previous.input, input))
      throw new Error("请求标识已用于另一项委派");
    if (data.tasks[previous.taskId]?.sourceRuntime !== parent.sourceRuntime)
      throw new Error("委派发起后端实例已更换");
    if (callKey) data.receipts[callKey] = previous;
    return { task_id: previous.taskId, status: "accepted" };
  }
  let task = findDelegationTask(
    data.tasks,
    { id: parent.id, runtimeId: parent.sourceRuntime },
    input.task_id,
  );
  if (input.task_id) {
    if (!task || task.parentId !== parent.id || task.target !== target)
      throw new Error("当前会话无法继续此委派任务");
    if (input.scope && input.scope !== task.scope)
      throw new Error("续问沿用原任务的执行范围");
    const prior = task.steps.at(-1);
    if (executing.has(task.status) || task.status === "unknown") {
      prior.supersededAt = Date.now();
      // Older records can reach native submission before saving its receipt.
      if (task.executor && task.status !== "accepted")
        prior.submittedAt ??= prior.acceptedAt;
    }
    for (const notice of Object.values(data.notices))
      if (notice.taskId === task.id && notice.status === "queued")
        notice.status = "superseded";
  } else {
    if (!snapshot) throw new Error("请启用委派接收端");
    task = {
      id: randomUUID(),
      parentId: parent.id,
      parentTurnId: turn.id,
      target,
      cwd: parent.cwd,
      ...(parent.sourceName && {
        sourceName: parent.sourceName,
        sourceRuntime: parent.sourceRuntime,
      }),
      selection: snapshot,
      scope: input.scope || "research",
      original: turn.original || [],
      steps: [],
    };
    data.tasks[task.id] = task;
  }
  task.steps.push({
    id: randomUUID(),
    request: input.request.trim(),
    ...(input.taskSummary && { taskSummary: input.taskSummary.trim() }),
    parentTurnId: turn.id,
    acceptedAt: Date.now(),
    original: turn.original || [],
  });
  task.status = "accepted";
  task.request = null;
  data.receipts[key] = { taskId: task.id, input, target };
  if (callKey) data.receipts[callKey] = data.receipts[key];
  return { task_id: task.id, status: "accepted" };
}

export function queueNotice(data, task, kind, payload) {
  const id = `${task.steps.at(-1).id}:${kind}`;
  data.notices[id] ||= {
    id,
    taskId: task.id,
    parentId: task.parentId,
    stepId: task.steps.at(-1).id,
    kind,
    payload,
    status: "queued",
    createdAt: Date.now(),
  };
}

export function currentResultNotice(data, notice) {
  const task = data.tasks[notice?.taskId];
  const step = task?.steps.at(-1);
  return Boolean(
    notice?.kind === "result" &&
    step &&
    (notice.stepId ?? notice.id.slice(0, -":result".length)) === step.id &&
    terminal.has(task.status),
  );
}

export function finishDelegation(data, task, status, result) {
  task.status = status;
  task.request = null;
  Object.assign(task.steps.at(-1), {
    result,
    completedAt: Date.now(),
  });
  queueNotice(
    data,
    task,
    "result",
    resultNoticePayload({ ...result, status, stepId: task.steps.at(-1).id }),
  );
}

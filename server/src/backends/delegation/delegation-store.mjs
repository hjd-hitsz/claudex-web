import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { resultNoticePayload } from "./call-chain.mjs";
import { deliveryAnswer } from "./delivery-summary.mjs";
import { delegationSnippet } from "../../../../shared/delivery-summary.mjs";
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
  "stopped_by_user",
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
    throw new Error(
      "委派失败，参数无效。请按工具参数说明检查任务要求、请求 ID、任务 ID、执行范围和任务标题后重试。",
    );
  const key = JSON.stringify([parent.id, input.request_id]);
  const callKey =
    callId &&
    JSON.stringify([parent.id, parent.sourceRuntime, turn.id, callId]);
  const previous = (callKey && data.receipts[callKey]) || data.receipts[key];
  if (previous) {
    if (previous.target !== target || !isDeepStrictEqual(previous.input, input))
      throw new Error(
        "委派失败，请求 ID 已用于不同的委派参数。请用新的请求 ID 提交本次请求。",
      );
    if (data.tasks[previous.taskId]?.sourceRuntime !== parent.sourceRuntime)
      throw new Error(
        "委派失败，当前后端实例与原请求所属实例不同。请切回原实例重试，或用新的请求 ID 新建委派任务。",
      );
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
      throw new Error(
        "委派续问失败，当前会话与接收端找不到该任务。请核对任务 ID，并在原会话中使用原接收端续问。",
      );
    if (input.scope && input.scope !== task.scope)
      throw new Error(
        `委派续问失败：原任务范围为 ${task.scope}，本次请求范围为 ${input.scope}。请用 ${input.scope} 新建委派任务，或改用 ${task.scope} 续问。`,
      );
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
    if (!snapshot)
      throw new Error(
        `委派失败，接收端 ${target} 未启用或未选中。请启用并选择该接收端后重试。`,
      );
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

function relatedResults(data, task, completedAt, answer) {
  const results = [];
  const seenAnswers = new Set([answer?.trim()]);
  // A newer step supersedes a queued notice. Carry nearby results that
  // have yet to enter native submission in the latest step's report.
  for (let index = task.steps.length - 2; index >= 0; index--) {
    const step = task.steps[index];
    const notice = data.notices[`${step.id}:result`];
    if (
      notice?.status !== "superseded" ||
      !step.result ||
      completedAt - notice.createdAt > 2500
    )
      break;
    const payload = resultNoticePayload({
      ...step.result,
      stepId: step.id,
      status: notice.payload.status,
    });
    const text = payload.answer?.trim();
    if (text && (seenAnswers.has(text) || text.length > 1024)) {
      const { answer, ...summary } = payload;
      results.push({
        ...summary,
        preview: summary.preview || delegationSnippet(answer),
        answerArchived: true,
      });
    } else {
      results.push(payload);
    }
    if (text) seenAnswers.add(text);
  }
  return results.reverse();
}

export function finishDelegation(data, task, status, result) {
  const settled = { ...result, deliveryAnswer: deliveryAnswer(result) };
  const completedAt = Date.now();
  task.status = status;
  task.request = null;
  Object.assign(task.steps.at(-1), {
    result: settled,
    completedAt,
  });
  const relatedSteps = relatedResults(
    data,
    task,
    completedAt,
    settled.deliveryAnswer,
  );
  queueNotice(data, task, "result", {
    ...resultNoticePayload({
      ...settled,
      status,
      stepId: task.steps.at(-1).id,
    }),
    ...(relatedSteps.length && { relatedSteps }),
  });
}

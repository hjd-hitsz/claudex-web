import { delegationMarker, executorResult } from "./executors.mjs";
import { finishDelegation } from "./delegation-store.mjs";
import { turnCalls } from "./call-chain.mjs";
import { shellTask } from "../claude/background-tasks.mjs";
import { delegationContext } from "./context.mjs";
import { deliveryAnswer } from "./delivery-summary.mjs";
import {
  delegationSnippet,
  deliverySnippet,
} from "../../../../shared/delivery-summary.mjs";

const terminal = new Set(["completed", "failed", "interrupted"]);
export const traceVersion = 2;
const codexNotices = new Map([
  ["background_completed", "completion"],
  ["background_check_due", "check"],
]);

export function awaitingCodexJob(job, step) {
  return (
    job.startedAt >= step.acceptedAt &&
    job.status !== "cancelled" &&
    !["consumed", "suppressed"].includes(job.delivery)
  );
}

export function initialTurn(turns, step) {
  return turns.find(
    (turn) =>
      turn.id === step.turnId ||
      turn.items?.some(
        (item) =>
          item.type === "userMessage" &&
          item.content
            ?.map((part) => part.text || "")
            .join("\n")
            .startsWith(delegationMarker(step.id)),
      ),
  );
}

function codexTriggers(turn) {
  return (turn.items || []).flatMap(({ type, name, output }) => {
    const kind = codexNotices.get(name);
    if (type !== "functionCallOutput" || !kind) return [];
    try {
      const text =
        typeof output === "string"
          ? output
          : output.map(({ text }) => text).join("");
      const { results } = JSON.parse(text);
      return results
        .filter(({ job_id }) => job_id)
        .map((result) => ({
          kind,
          id: result.job_id,
          title: result.title,
          status: result.status,
        }));
    } catch {
      return [];
    }
  });
}

function claudeTriggers(turn, tasks) {
  return (turn.backgroundTriggers || []).map(({ id, runId }) => ({
    kind: "completion",
    id,
    runId,
    title: tasks[id]?.description || tasks[id]?.summary,
    status: tasks[id]?.status,
  }));
}

function triggerDetails({ id, title, runId }) {
  return `${title || "终端"}（ID ${id}${runId ? `，运行 ID ${runId}` : ""}）`;
}

function stageSection({ triggers }, index, answer, dispatchTitle) {
  if (!index) return `## ${dispatchTitle}\n\n${answer}`;
  if (!triggers.length) return `## 原生续跑 · 第 ${index + 1} 轮\n\n${answer}`;
  const count = triggers.length;
  const checks = triggers.filter(({ kind }) => kind === "check").length;
  const kind = checks === count ? "软检查" : checks === 0 ? "完成" : "";
  if (count === 1)
    return `## 后台终端${kind} · ${triggerDetails(triggers[0])}\n\n${answer}`;
  const details = triggers
    .map((trigger) => {
      const prefix = kind
        ? ""
        : trigger.kind === "check"
          ? "软检查 · "
          : "完成 · ";
      const detail = triggerDetails(trigger)
        .replace(/[\r\n]+/g, " ")
        .trimStart()
        .replace(
          /[\\`*_\[\]<>~&$]/g,
          (character) => `&#${character.charCodeAt(0)};`,
        );
      return `- ${prefix}${detail}`;
    })
    .join("\n");
  return `## 后台终端${kind} · ${count} 项\n\n${details}\n\n${answer}`;
}

export function delegationStage(turn, triggers, target, trace) {
  return {
    turnId: turn.id,
    status: terminal.has(turn.status) ? turn.status : "unknown",
    triggers,
    ...executorResult(turn, trace, target),
    callChain: turnCalls(turn, trace, target),
  };
}

export function delegationResults(
  thread,
  initial,
  step,
  background,
  occupied,
  target,
  rollout,
) {
  const turns = thread.turns || [];
  const tasks = thread.backgroundTasks || {};
  const triggersFor = (turn) =>
    target === "claude" ? claudeTriggers(turn, tasks) : codexTriggers(turn);
  const stage = [{ turn: initial, triggers: [] }];
  const jobs = new Map(background.jobs.map((job) => [job.id, job]));
  for (const turn of turns.slice(turns.indexOf(initial) + 1)) {
    if (turn.items?.some(({ type }) => type === "userMessage")) break;
    const triggers = triggersFor(turn);
    const fromPriorStep =
      triggers.length &&
      triggers.every(({ id }) => {
        const job = target === "claude" ? tasks[id] : jobs.get(id);
        return job?.startedAt < step.acceptedAt;
      });
    if (!fromPriorStep && (triggers.length || turn.automatic))
      stage.push({ turn, triggers });
  }
  const receipts = turns.flatMap((turn) =>
    terminal.has(turn.status) ? triggersFor(turn) : [],
  );
  const completionReceived = (id, runId) =>
    receipts.some(
      (source) =>
        source.kind === "completion" &&
        source.id === id &&
        (!runId || source.runId === runId),
    );
  // Process exit precedes the native wake-up. Require the resulting turn's
  // receipt before settling a completion that has not been consumed elsewhere.
  const waitingCodex = background.jobs.some(
    (job) => awaitingCodexJob(job, step) && !completionReceived(job.id),
  );
  const itemIds = new Set(
    stage.flatMap(({ turn }) => (turn.items ?? []).map(({ id }) => id)),
  );
  const trackedProcesses = new Set(
    background.jobs.map((job) => job.native?.processId ?? job.id),
  );
  const waitingNative =
    target === "codex" &&
    background.terminals.some(
      ({ itemId, processId }) =>
        !trackedProcesses.has(processId) && itemIds.has(itemId),
    );
  const waitingClaude = Object.values(tasks).some(
    (task) =>
      task.startedAt >= step.acceptedAt &&
      shellTask(task) &&
      !task.skip_transcript &&
      ["running", "pending", "completed", "failed"].includes(task.status) &&
      !(task.notifiedAt < initial.completedAt * 1000) &&
      !completionReceived(task.task_id, task.run_id),
  );
  const lastTurnId = stage.at(-1).turn.id;
  return {
    turnIds: stage.map(({ turn }) => turn.id),
    context: delegationContext(
      thread,
      lastTurnId,
      rollout?.get(lastTurnId)?.context,
    ),
    pending:
      occupied ||
      waitingNative ||
      waitingCodex ||
      waitingClaude ||
      stage.some(({ turn }) => ["inProgress", "queued"].includes(turn.status)),
    stages: stage
      .filter(({ turn }) => !["inProgress", "queued"].includes(turn.status))
      .map(({ turn, triggers }) =>
        delegationStage(turn, triggers, target, rollout?.get(turn.id)),
      ),
  };
}

export function summarizeDelegationStages(stages) {
  const answer =
    stages.length === 1
      ? stages[0].answer
      : stages
          .map((stage, index) =>
            stageSection(
              stage,
              index,
              stage.answer || "（本轮无文字回复）",
              "当前委派",
            ),
          )
          .join("\n\n");
  const errors = stages.map(({ error }) => error).filter(Boolean);
  return {
    traceVersion,
    answer,
    ...(stages.at(-1)?.conclusion !== undefined && {
      conclusion: stages.at(-1).conclusion,
    }),
    callChain: stages.flatMap(({ callChain }) => callChain ?? []),
    turns: stages.map(({ turnId, status, triggers, callChain }) => ({
      turnId,
      status,
      triggers,
      callCount: callChain?.length ?? 0,
    })),
    evidence: stages.flatMap(({ evidence }) => evidence),
    artifacts: stages.flatMap(({ artifacts }) => artifacts),
    ...(errors.length && { error: errors.join("\n") }),
  };
}

function delegationDelivery(stages) {
  const sections = stages.flatMap((stage, index) => {
    const answer = deliveryAnswer(stage);
    if (!answer) return [];
    return [{ answer, stage, index }];
  });
  const first = sections[0]?.answer;
  return {
    deliveryAnswer:
      sections.length > 1
        ? sections
            .map(({ answer, stage, index }) =>
              stageSection(stage, index, answer, "派单轮答复"),
            )
            .join("\n\n")
        : (first ?? null),
    deliveryPreview: first
      ? delegationSnippet(first) || deliverySnippet(first)
      : "",
  };
}

export function saveDelegationResults(
  data,
  task,
  { pending, stages, context },
) {
  if (pending) return;
  const step = task.steps.at(-1);
  const status = step.stopRequested
    ? "stopped_by_user"
    : ["failed", "interrupted", "unknown"].find((status) =>
        stages.some((stage) => stage.status === status),
      ) || "completed";
  step.turnId = stages[0].turnId;
  finishDelegation(data, task, status, {
    ...summarizeDelegationStages(stages),
    ...delegationDelivery(stages),
    ...(context && { context }),
  });
}

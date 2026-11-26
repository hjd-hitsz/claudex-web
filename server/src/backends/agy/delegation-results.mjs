import { delegationMarker, executorResult } from "./executors.mjs";
import { finishDelegation } from "./delegation-store.mjs";
import { shellTask } from "../claude/background-tasks.mjs";

const terminal = new Set(["completed", "failed", "interrupted"]);
const codexNotices = new Map([
  ["background_completed", "completion"],
  ["background_check_due", "check"],
]);

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

function label({ triggers, turnId }, index) {
  if (!index) return "当前委派";
  if (!triggers.length) return "原生续跑 · " + turnId;
  return triggers
    .map(
      ({ kind, id, title, runId }) =>
        `${kind === "check" ? "后台终端软检查" : "后台终端完成"} · ${title || "终端"}（ID ${id}${runId ? `，运行 ID ${runId}` : ""}）`,
    )
    .join("、");
}

export function delegationResults(
  thread,
  initial,
  step,
  background,
  occupied,
  target,
) {
  const turns = thread.turns || [];
  const tasks = thread.backgroundTasks || {};
  const triggersFor = (turn) =>
    target === "claude" ? claudeTriggers(turn, tasks) : codexTriggers(turn);
  const stage = [{ turn: initial, triggers: [] }];
  const terminals = new Map(background.jobs.map((job) => [job.id, job]));
  for (const turn of turns.slice(turns.indexOf(initial) + 1)) {
    if (turn.items?.some(({ type }) => type === "userMessage")) break;
    const triggers = triggersFor(turn);
    const fromPriorStep =
      triggers.length &&
      triggers.every(({ id }) => {
        const job = target === "claude" ? tasks[id] : terminals.get(id);
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
    ({ id, status, delivery }) =>
      status !== "cancelled" &&
      !["consumed", "suppressed"].includes(delivery) &&
      !completionReceived(id),
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
  return {
    turnIds: stage.map(({ turn }) => turn.id),
    pending:
      occupied ||
      background.terminals.length > 0 ||
      waitingCodex ||
      waitingClaude ||
      stage.some(({ turn }) => ["inProgress", "queued"].includes(turn.status)),
    stages: stage
      .filter(({ turn }) => !["inProgress", "queued"].includes(turn.status))
      .map(({ turn, triggers }) => ({
        turnId: turn.id,
        status: terminal.has(turn.status) ? turn.status : "unknown",
        triggers,
        ...executorResult(turn),
      })),
  };
}

export function saveDelegationResults(data, task, { pending, stages }) {
  if (pending) return;
  const step = task.steps.at(-1);
  const status = step.stopRequested
    ? "interrupted"
    : ["failed", "interrupted", "unknown"].find((status) =>
        stages.some((stage) => stage.status === status),
      ) || "completed";
  const answer =
    stages.length === 1
      ? stages[0].answer
      : stages
          .map(
            (stage, index) =>
              `## ${label(stage, index)}\n\n${stage.answer || "（本轮无最终回复）"}`,
          )
          .join("\n\n");
  const errors = stages.map(({ error }) => error).filter(Boolean);
  step.turnId = stages[0].turnId;
  finishDelegation(data, task, status, {
    answer,
    turns: stages.map(({ turnId, status, triggers }) => ({
      turnId,
      status,
      triggers,
    })),
    evidence: stages.flatMap(({ evidence }) => evidence),
    artifacts: stages.flatMap(({ artifacts }) => artifacts),
    ...(errors.length && { error: errors.join("\n") }),
  });
}

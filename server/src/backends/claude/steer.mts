import { randomUUID } from "node:crypto";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { assertConversationOperation } from "../../bridge/conversation-policy.mjs";
import { peerInputState } from "./conversation-input.mjs";
import { convertMessage } from "./messages.mjs";
import { inputMessage, userPrompt } from "./prompt.mjs";
import type { ConversationInput } from "./conversation-protocol.d.mts";
import type {
  ActiveExecution,
  ExecutionActivity,
  QueuedInput,
  RuntimeDependencies,
  SessionDependencies,
  TurnRequest,
} from "./execution-types.d.mts";

type SteerDependencies = Pick<RuntimeDependencies, "storage" | "compactions"> &
  Pick<SessionDependencies, "save" | "emit"> & {
    running: Map<string, ActiveExecution>;
    queries: Map<string, ExecutionActivity & { query: Query }>;
  };

export function createSteer({
  running,
  queries,
  storage,
  compactions,
  save,
  emit,
}: SteerDependencies) {
  return async (
    threadId: string,
    params: Pick<TurnRequest, "input"> & { expectedTurnId?: string },
  ) => {
    const active = running.get(threadId);
    if (!active || !active.query || active.interrupted)
      throw new Error("当前轮次已结束，请重新发送");
    if (params.expectedTurnId && params.expectedTurnId !== active.turn.id)
      throw new Error("当前轮次已变化，请重新发送");
    assertConversationOperation("turn/steer", {
      compacting: compactions.busy(threadId),
    });
    inputMessage(params.input);
    const session = (await storage.read()).sessions[threadId];
    const queued = { id: randomUUID(), input: params.input };
    active.inputIds.add(queued.id);
    const message = userPrompt(session, queued, "now");
    await save(threadId, (s) => ({
      ...s,
      inputTurns: { ...s.inputTurns, [queued.id]: active.turn.id },
      extraItems: {
        ...s.extraItems,
        [queued.id]: {
          id: queued.id,
          type: "userMessage",
          turnId: active.turn.id,
          content: inputMessage(params.input),
        },
      },
    }));
    for (const item of convertMessage(message, active.turn.id)) {
      active.turn.items.push(item);
      emit("item/completed", { threadId, turnId: active.turn.id, item });
    }
    const process = queries.get(threadId);
    if (!process) throw new Error("当前轮次已结束，请重新发送");
    process.input.push(message);
    process.lastActivityAt = Date.now();
    return { turnId: active.turn.id };
  };
}

export function createPeerSteer(
  { running, queries, compactions, save, emit }: SteerDependencies,
  available: (threadId: string) => boolean,
) {
  return async (
    threadId: string,
    peer: ConversationInput,
    input: TurnRequest["input"],
    writable: () => boolean,
  ): Promise<"queued" | "deferred" | "failed"> => {
    const active = running.get(threadId);
    const process = queries.get(threadId);
    if (!active || !process) return "deferred";
    const canSubmit = () =>
      running.get(threadId) === active &&
      queries.get(threadId) === process &&
      active.query === process.query &&
      active.turn.status === "inProgress" &&
      !active.interrupted &&
      process.correlatedInput &&
      !process.ended &&
      !process.retired &&
      !process.commands.busy &&
      process.nativeState !== "requires_action" &&
      !compactions.busy(threadId) &&
      available(threadId) &&
      writable();
    if (!canSubmit()) return "deferred";
    const queued = { id: peer.id as QueuedInput["id"], input, peer };
    let result: "queued" | "deferred" | "failed" = "deferred";
    let message: ReturnType<typeof userPrompt> | undefined;
    await save(threadId, (s) => {
      if (s && !s.deleted && !s.archived) {
        if (s.peerInputs?.[peer.id]) result = "queued";
        else if (canSubmit()) {
          message = userPrompt(s, queued, "next");
          return {
            ...s,
            ...peerInputState(s, queued),
            inputTurns: { ...s.inputTurns, [peer.id]: active.turn.id },
          };
        }
      } else result = "failed";
      return s;
    });
    if (!message) return result;
    const defer = async () => {
      // The input has not entered the native stream and can safely be retried.
      await save(threadId, (s) => {
        const peerInputs = { ...s.peerInputs };
        const inputTurns = { ...s.inputTurns };
        delete peerInputs[peer.id];
        delete inputTurns[peer.id];
        return { ...s, peerInputs, inputTurns };
      });
      return "deferred" as const;
    };
    if (!canSubmit()) return defer();
    try {
      process.input.push(message);
    } catch {
      return defer();
    }
    active.inputIds.add(peer.id);
    (active.peerInputIds ||= new Set()).add(peer.id);
    process.lastActivityAt = Date.now();
    for (const item of convertMessage(message, active.turn.id)) {
      active.turn.items.push(item);
      emit("item/completed", { threadId, turnId: active.turn.id, item });
    }
    return "queued";
  };
}

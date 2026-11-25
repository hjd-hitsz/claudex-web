import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ConversationInput } from "./conversation-protocol.d.mts";
import type {
  ActiveExecution,
  QueuedInput,
  SaveSession,
  SessionRecord,
  TurnRequest,
} from "./execution-types.d.mts";

export function queuedInput(
  params: TurnRequest,
  input: QueuedInput["input"],
  compact: boolean,
  peer?: ConversationInput,
): QueuedInput {
  return {
    id: peer ? (peer.id as QueuedInput["id"]) : randomUUID(),
    status: "queued",
    input,
    model: params.model,
    providerId: params.providerId,
    compact,
    mode: params.collaborationMode?.mode || "default",
    effort: params.effort,
    serviceTier: params.serviceTier,
    review: params.review === true,
    goalId: params.goalId,
    createdAt: Date.now() / 1000,
    ...(peer && { peer }),
  };
}

export function peerInputState(
  current: SessionRecord,
  turn: Pick<QueuedInput, "id" | "peer">,
): Pick<SessionRecord, "peerInputs"> | object {
  if (!turn.peer) return {};
  const nativeSessionId = current.nativeSessionId || current.id;
  return {
    peerInputs: {
      ...current.peerInputs,
      [turn.id]: {
        nativeSessionId,
        cwd: current.cwd,
        from: turn.peer.from,
      },
    },
  };
}

export function assertPeerQueue(
  session: SessionRecord,
  id: string,
  occupied: boolean,
) {
  if (!session || session.deleted || session.archived)
    throw Object.assign(new Error("会话已关闭"), {
      code: "ECLAUDECONVERSATIONCLOSED",
    });
  if (session.peerInputs?.[id]) return;
  if (occupied || session.queue?.length)
    throw Object.assign(new Error("会话正在处理前序输入"), {
      code: "ECLAUDECONVERSATIONBUSY",
    });
}

export function recordPeerAcceptance(threadId: string, save: SaveSession) {
  let owner: ActiveExecution | undefined | null;
  const acknowledged = new Set<string>();
  return async (message: SDKMessage, active?: ActiveExecution | null) => {
    if (owner !== active) {
      owner = active;
      acknowledged.clear();
    }
    if (
      !active ||
      (!active.queued.peer && !active.peerInputIds?.size) ||
      ("parent_tool_use_id" in message && message.parent_tool_use_id) ||
      (message.type !== "stream_event" &&
        message.type !== "assistant" &&
        message.type !== "result")
    )
      return;
    // A native result supplies each consumed UUID even when the assistant stream
    // of a typed turn continues to identify the original user input.
    const ids = (
      message.type === "result"
        ? (message.user_message_uuids ?? [])
        : (message.user_message_uuids ?? [message.user_message_uuid])
    ).filter(
      (id): id is string =>
        typeof id === "string" &&
        !acknowledged.has(id) &&
        (Boolean(active.queued.peer && active.turn.id === id) ||
          Boolean(active.peerInputIds?.has(id))),
    );
    if (!ids.length) return;
    const nativeReceipt =
      message.type === "result"
        ? "claude-native-result"
        : "claude-native-stream";
    await save(threadId, (s) => {
      const inputs = { ...s.peerInputs };
      for (const id of ids)
        if (inputs[id])
          inputs[id] = { ...inputs[id], nativeAccepted: true, nativeReceipt };
      return { ...s, peerInputs: inputs };
    });
    for (const id of ids) acknowledged.add(id);
  };
}

export function recordPeerRejection(
  threadId: string,
  id: string,
  save: SaveSession,
  reason: string,
) {
  return save(threadId, (s) => removeQueuedInput(s, id, reason));
}

export function removeQueuedInput(
  s: SessionRecord,
  id: string,
  reason: string,
): SessionRecord {
  const peer = s.peerInputs?.[id];
  return {
    ...s,
    queue: s.queue?.filter((entry) => entry.id !== id),
    ...(peer && {
      peerInputs: { ...s.peerInputs, [id]: { ...peer, rejected: reason } },
    }),
  };
}

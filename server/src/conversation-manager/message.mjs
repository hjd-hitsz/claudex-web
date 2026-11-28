import { renderPrompt, readPromptSections } from "../prompts.mjs";
import { contextMetrics } from "../../../shared/delegation-context.mjs";
import { delegationPreview } from "../../../shared/delivery-summary.mjs";

const peer = readPromptSections("conversation/collaboration.md");

const delegationResult = readPromptSections("delegation/workflow.md")(
  "nativeResult",
);

function peerMessagePrefix({ id, replyTo, from }) {
  const source = JSON.stringify({
    threadId: from.threadId,
    runtimeId: from.runtimeId,
    title: from.title,
    ...(replyTo && { replyTo }),
  });
  return `Claudex thread_chat message ${id}\nPeer conversation: ${source}\n`;
}

function delegationResultPrefix({ id, displayId, from }) {
  return (
    "Claudex 委派执行结果 " + (displayId ?? id) + " · " + from.title + "\n"
  );
}

export function delegationResultItem(item, text, messageId) {
  const header =
    /^Claudex 委派执行结果 ([\da-f-]{8,36}) · (Codex|Claude Code)\n/i.exec(
      text,
    );
  if (
    !header ||
    (messageId &&
      header[1] !== messageId &&
      header[1] !== messageId.slice(0, 8))
  )
    return item;
  let payload;
  try {
    payload = JSON.parse(text.slice(text.lastIndexOf("\n") + 1));
  } catch {
    return item;
  }
  if (
    payload?.stepId !== header[1] ||
    !/^(?:[\da-f]{8}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.test(
      payload.task_id,
    ) ||
    ![
      "completed",
      "failed",
      "interrupted",
      "stopped_by_user",
      "unknown",
    ].includes(payload.status)
  )
    return item;
  const context = contextMetrics(payload.context);
  return {
    id: item.id,
    turnId: item.turnId,
    type: "delegationResult",
    taskId: payload.task_id.slice(0, 8),
    stepId: payload.stepId.slice(0, 8),
    preview:
      typeof payload.preview === "string"
        ? payload.preview
        : delegationPreview(payload.answer),
    target: header[2] === "Codex" ? "codex" : "claude",
    status: payload.status,
    ...(context && { context }),
  };
}

export function matchesConversationMessage(text, envelope) {
  if (typeof text !== "string") return false;
  const prefix = envelope.delegation
    ? delegationResultPrefix(envelope)
    : peerMessagePrefix(envelope);
  if (!text.startsWith(prefix)) return false;
  const content = text.slice(prefix.length);
  // Match the saved payload independently of the editable guidance above it.
  const separator = envelope.delegation ? "\n" : "\nMessage body:\n";
  const boundary = envelope.delegation
    ? content.lastIndexOf(separator)
    : content.indexOf(separator);
  return (
    boundary >= 0 &&
    content.slice(boundary + separator.length) === envelope.body
  );
}

function formatPeerMessage(envelope, provenance, guidance) {
  return (
    peerMessagePrefix(envelope) +
    [provenance, guidance, "Message body:", envelope.body].join("\n")
  );
}

export function formatLegacyConversationMessage(envelope) {
  return formatPeerMessage(
    envelope,
    peer("legacyProvenance"),
    renderPrompt(peer("legacyRequest"), { id: envelope.id }),
  );
}

export function formatConversationMessage(envelope, serverName) {
  if (envelope.delegation)
    return (
      delegationResultPrefix(envelope) + delegationResult + "\n" + envelope.body
    );
  const guidance = envelope.replyTo
    ? peer("reply")
    : renderPrompt(peer("request"), { id: envelope.id, serverName });
  return formatPeerMessage(envelope, peer("provenance"), guidance);
}

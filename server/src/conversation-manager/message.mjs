import { renderPrompt, readPromptSections } from "../prompts.mjs";

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

function delegationResultPrefix({ id, from }) {
  return "Claudex 委派执行结果 " + id + " · " + from.title + "\n";
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

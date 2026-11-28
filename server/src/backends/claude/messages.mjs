import { executionError } from "./execution-errors.mjs";
import { conversationMessageItem } from "../../conversation-manager/message.mjs";
import { claudeConversationServerName } from "../../conversation-manager/tools.mjs";
import { historicalClaudeUsage, mergeClaudeUsage } from "./token-usage.mjs";

function imageUrl(block) {
  return block.source?.type === "base64"
    ? `data:${block.source.media_type};base64,${block.source.data}`
    : block.source?.url;
}

function contentBlocks(message) {
  const content = message.message?.content;
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content || [];
}

function isCompactCommand(message) {
  return (
    message.type === "user" &&
    message.isCompletedLocalCommand &&
    typeof message.message?.content === "string" &&
    message.message.content.startsWith("<command-name>/compact</command-name>")
  );
}
export function visibleSessionMessages(messages, internalInputIds = {}) {
  const promptIds = new Set(
    messages
      .filter((message) => internalInputIds[message.uuid])
      .map((message) => message.promptId)
      .filter(Boolean),
  );
  return messages.filter(
    (message) =>
      !internalInputIds[message.uuid] &&
      !promptIds.has(message.promptId) &&
      !(
        message.type === "system" &&
        message.subtype === "local_command" &&
        internalInputIds[message.parentUuid]
      ),
  );
}
export function projectClaudeConversationItem(item, source) {
  const [content] = item.content ?? [];
  return item.type === "userMessage" &&
    item.content?.length === 1 &&
    content.type === "text"
    ? conversationMessageItem(item, content.text, {
        serverName: claudeConversationServerName,
        source,
      })
    : item;
}

export function sessionHistoryTurns(messages, session) {
  const { internalInputIds, peerInputs, turns, turnIds, inputTurns } = session;
  return historyTurns(
    visibleSessionMessages(messages, internalInputIds).map((message) => {
      const previousId = message.forkedFrom?.messageUuid;
      const peer =
        message.type === "user" &&
        (peerInputs?.[message.uuid] ?? peerInputs?.[previousId]);
      return peer
        ? {
            ...message,
            peerMessageId: peer.sourceMessageId ?? previousId ?? message.uuid,
            origin: {
              kind: "peer",
              from: peer.from.threadId,
              name: peer.from.title,
            },
          }
        : message;
    }),
    turns,
    turnIds,
    inputTurns,
  );
}

export function convertMessage(
  message,
  turnId,
  tools = new Map(),
  mode = "default",
  blockOffset = 0,
) {
  if (
    message.isApiErrorMessage ||
    message.isMeta ||
    message.is_meta ||
    message.isCompactSummary ||
    message.isVisibleInTranscriptOnly ||
    (message.type === "assistant" && message.error)
  )
    return [];
  const blocks = contentBlocks(message),
    items = [];
  const messageId = message.message?.id || message.uuid;
  if (message.type === "user") {
    const source = isCompactCommand(message)
      ? [
          {
            type: "text",
            text: [
              "/compact",
              /<command-args>([\s\S]*?)<\/command-args>\s*$/
                .exec(message.message.content)?.[1]
                ?.trim(),
            ]
              .filter(Boolean)
              .join(" "),
          },
        ]
      : blocks;
    const content = source
      .filter((b) => ["text", "image"].includes(b.type))
      .map((b) =>
        b.type === "text"
          ? b
          : {
              type: "image",
              url: imageUrl(b),
            },
      );
    if (content.length && isUserPrompt(message)) {
      const peer = message.origin?.kind === "peer";
      const item = {
        id: message.uuid,
        turnId,
        type: "userMessage",
        content,
        ...(peer && {
          authorLabel: message.origin.name || message.origin.from,
        }),
      };
      items.push(
        peer
          ? projectClaudeConversationItem(item, {
              id: message.peerMessageId ?? message.uuid,
              threadId: message.origin.from,
            })
          : item,
      );
    }
    for (const block of blocks.filter((b) => b.type === "tool_result")) {
      const prior = tools.get(block.tool_use_id);
      if (prior) {
        const contentItems =
          typeof block.content === "string"
            ? [{ type: "text", text: block.content }]
            : (block.content || []).map((content) =>
                content.type === "image"
                  ? { ...content, url: imageUrl(content) }
                  : content,
              );
        const item = {
          ...prior,
          nativeOutputId: message.uuid,
          status: block.is_error ? "failed" : "completed",
          ...(prior.type === "commandExecution"
            ? {
                aggregatedOutput:
                  typeof block.content === "string"
                    ? block.content
                    : JSON.stringify(block.content || []),
                exitCode: block.is_error ? 1 : 0,
              }
            : block.is_error
              ? { result: null, contentItems: [], error: contentItems }
              : { result: block.content, contentItems, error: null }),
        };
        tools.set(item.id, item);
        items.push(item);
      }
    }
    return items;
  }
  if (message.type === "system" && message.subtype === "compact_boundary")
    return [
      {
        id: message.uuid,
        turnId,
        type: "contextCompaction",
        status: "completed",
      },
    ];
  if (message.type !== "assistant") return items;
  blocks.forEach((block, index) => {
    const id = `${messageId}-${blockOffset + index}`;
    if (block.type === "text")
      items.push({
        id,
        turnId,
        type:
          mode === "plan" && message.message?.stop_reason === "end_turn"
            ? "plan"
            : "agentMessage",
        text: block.text,
        phase:
          message.message?.stop_reason === "end_turn"
            ? "final_answer"
            : "commentary",
      });
    if (block.type === "thinking")
      items.push({
        id,
        turnId,
        type: "reasoning",
        summary: [{ title: "思考", text: block.thinking }],
      });
    if (block.type === "redacted_thinking")
      items.push({
        id,
        turnId,
        type: "reasoning",
        summary: [{ title: "思考", text: "思考内容已加密" }],
      });
    if (block.type === "tool_use") {
      const item =
        block.name === "Bash"
          ? {
              id: block.id,
              turnId,
              type: "commandExecution",
              command: block.input.command,
              arguments: block.input,
              cwd: "",
              status: "inProgress",
              aggregatedOutput: "",
            }
          : {
              id: block.id,
              turnId,
              type: "dynamicToolCall",
              tool: block.name,
              arguments: block.input,
              status: "inProgress",
              contentItems: [],
            };
      item.nativeInputId = message.uuid;
      tools.set(block.id, item);
      items.push(item);
    }
  });
  return items;
}
export function isUserPrompt(message) {
  return (
    message.type === "user" &&
    !message.isMeta &&
    !message.is_meta &&
    !message.isCompactSummary &&
    !message.isVisibleInTranscriptOnly &&
    !message.isSynthetic &&
    message.origin?.kind !== "task-notification" &&
    // SDK 主对话附加记录仅继承入口；原生子代理任务由侧链及代理标识确认来源。
    !(
      message.entrypoint === "sdk-ts" &&
      !(message.isSidechain === true && message.agentId) &&
      message.promptId &&
      !message.promptSource &&
      !message.turnOrigin &&
      !message.turnPosition &&
      !message.origin &&
      !isCompactCommand(message)
    ) &&
    contentBlocks(message).some((block) =>
      ["text", "image"].includes(block.type),
    )
  );
}

function* orderCompactionMessages(messages) {
  let boundary;
  let commandId;
  for (const message of messages) {
    const localText =
      message.isCompletedLocalCommand &&
      message.type === "user" &&
      message.message?.content;
    if (boundary) {
      if (message.isCompactSummary) continue;
      if (isCompactCommand(message)) {
        yield message;
        yield boundary;
        boundary = undefined;
        commandId = message.uuid;
        continue;
      }
      yield boundary;
      boundary = undefined;
    }
    if (
      commandId &&
      message.parentUuid === commandId &&
      typeof localText === "string" &&
      localText.startsWith("<local-command-stdout>")
    ) {
      commandId = message.uuid;
      continue;
    }
    if (
      message.type === "system" &&
      message.subtype === "compact_boundary" &&
      message.compactMetadata?.trigger === "manual"
    )
      boundary = message;
    else yield message;
  }
  if (boundary) yield boundary;
}

export function historyTurns(
  messages,
  savedTurns = {},
  turnIds = {},
  inputTurns = {},
) {
  const turns = [],
    tools = new Map(),
    blockOffsets = new Map();
  const usageByTurn = new Map();
  const usageOwners = new Map();
  const anchors = new Map(
    Object.values(savedTurns).flatMap((saved) =>
      [saved.nativeAnchorId, ...(saved.nativeMessageIds || [])]
        .filter(Boolean)
        .map((id) => [id, saved.id]),
    ),
  );
  let turn;
  let notifications = [];
  for (const message of orderCompactionMessages(messages)) {
    if (
      message.type === "user" &&
      message.origin?.kind === "task-notification"
    ) {
      const text = contentBlocks(message)
        .map((block) => block.text || "")
        .join("");
      const id = /^<task-notification>\s*<task-id>([^<]+)<\/task-id>/.exec(
        text,
      )?.[1];
      if (id) notifications.push({ id, runId: message.origin.runId });
    }
    const anchorId =
      anchors.get(message.uuid) ||
      (message.type === "assistant" && anchors.get(message.message?.id));
    if (isUserPrompt(message) || anchorId) {
      const id =
        anchorId ||
        turnIds[message.uuid] ||
        inputTurns[message.uuid] ||
        message.uuid;
      turn = turns.find((existing) => existing.id === id);
      if (!turn) {
        turn = {
          id,
          status: "completed",
          startedAt: message.timestamp
            ? Date.parse(message.timestamp) / 1000
            : undefined,
          ...savedTurns[id],
          items: [],
        };
        turns.push(turn);
      }
    }
    if (!turn) continue;
    if (message.type === "assistant" && notifications.length) {
      // The transcript can expose a wake-up before the worker saves its turn.
      if (anchorId || !turn.items.some(({ phase }) => phase === "final_answer"))
        (turn.backgroundTriggers ||= []).push(...notifications);
      notifications = [];
    }
    if (
      message.isApiErrorMessage ||
      (message.type === "assistant" && message.error)
    ) {
      turn.status = "failed";
      turn.error = executionError({
        message: contentBlocks(message)
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n"),
      });
    }
    if (
      message.type === "assistant" &&
      !message.isApiErrorMessage &&
      !message.error &&
      message.message?.stop_reason === "end_turn" &&
      savedTurns[turn.id]?.status !== "failed"
    ) {
      turn.status = savedTurns[turn.id]?.status || "completed";
      delete turn.error;
    }
    const converted = convertMessage(
      message,
      turn.id,
      tools,
      turn.mode,
      blockOffsets.get(message.message?.id || message.uuid) || 0,
    );
    if (
      (converted.length || message.isApiErrorMessage || message.error) &&
      message.timestamp &&
      ["completed", "failed", "interrupted"].includes(turn.status) &&
      !Number.isFinite(savedTurns[turn.id]?.completedAt)
    )
      turn.completedAt = Date.parse(message.timestamp) / 1000;
    const messageId = message.message?.id || message.uuid;
    const blockOffset = blockOffsets.get(messageId) || 0;
    if (
      message.type === "assistant" &&
      !message.isSidechain &&
      !message.parent_tool_use_id &&
      !message.isApiErrorMessage &&
      !message.error &&
      messageId &&
      message.message?.usage
    ) {
      const owner = usageOwners.get(messageId) ?? turn;
      usageOwners.set(messageId, owner);
      if (!usageByTurn.has(owner)) usageByTurn.set(owner, new Map());
      const counts = usageByTurn.get(owner);
      counts.set(
        messageId,
        mergeClaudeUsage(counts.get(messageId), message.message.usage),
      );
    }
    if (message.type === "assistant")
      blockOffsets.set(messageId, blockOffset + contentBlocks(message).length);
    for (const item of converted) {
      if (["agentMessage", "plan"].includes(item.type)) {
        const saved = savedTurns[turn.id]?.items?.find(
          (entry) => entry.id === item.id,
        );
        if (saved && ["agentMessage", "plan"].includes(saved.type)) {
          item.type = saved.type;
          item.phase = saved.phase;
        }
      }
      if (
        ["userMessage", "peerMessage"].includes(item.type) &&
        turnIds[item.id]
      )
        item.id = turnIds[item.id];
      const existing = turn.items.findIndex((i) => i.id === item.id);
      if (existing >= 0) turn.items[existing] = item;
      else turn.items.push(item);
    }
  }
  for (const [turn, messages] of usageByTurn) {
    if (turn.tokenUsage?.round) continue;
    const tokenUsage = historicalClaudeUsage(messages);
    if (Object.keys(tokenUsage.round).length)
      turn.tokenUsage = { ...tokenUsage, turnId: turn.id };
  }
  return turns;
}

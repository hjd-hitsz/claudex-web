import { acpFileChanges } from "./acp-files.mjs";
import { visibleAcpMessage } from "./acp-messages.mjs";
import { randomUUID } from "node:crypto";
import { measureAgyUsage } from "./context-usage.mjs";

export function acpCommands(update) {
  if (update?.sessionUpdate !== "available_commands_update") return;
  const commands = new Map();
  for (const { name, description, input } of update.availableCommands || []) {
    if (typeof name !== "string" || !/^[\w:-]+$/.test(name)) continue;
    const key = name.toLowerCase();
    if (!commands.has(key))
      commands.set(key, { name: key, description, argumentHint: input?.hint });
  }
  return [...commands.values()];
}

export async function waitForAcpCommands(ready) {
  // The optional command notification can arrive after session/new or resume.
  let timeout;
  try {
    return await Promise.race([
      ready,
      new Promise((resolve) => {
        timeout = setTimeout(resolve, 1000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function acpContent(input) {
  return (input || []).map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image" && part.url?.startsWith("data:")) {
      const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(part.url);
      if (match) return { type: "image", mimeType: match[1], data: match[2] };
    }
    if (part.type === "localImage" || part.type === "image")
      throw new Error("agy 图片需要嵌入内容，请重新添加该附件");
    if (part.path) return { type: "text", text: "附件文件：" + part.path };
    throw new Error("agy 暂不支持此输入类型：" + part.type);
  });
}

function put(turn, item, emit) {
  const current = turn.items.find((entry) => entry.id === item.id);
  if (current) Object.assign(current, item);
  else turn.items.push(item);
  emit("item/completed", { turnId: turn.id, item: current || item });
}

function appendText(activity, field, text, emit) {
  if (!text) return;
  const { turn } = activity;
  const message = field === "message";
  if (!activity[field]) {
    const item = {
      id: randomUUID(),
      ...(message
        ? { type: "agentMessage", text: "", phase: "final_answer" }
        : { type: "reasoning", summary: [""], expandableSummary: true }),
    };
    activity[field] = item;
    turn.items.push(item);
    emit("item/started", { turnId: turn.id, item });
  }
  const item = activity[field];
  if (message) item.text += text;
  else item.summary[0] += text;
  emit(
    message ? "item/agentMessage/delta" : "item/reasoning/summaryTextDelta",
    {
      itemId: item.id,
      turnId: turn.id,
      delta: text,
      ...(!message && { summaryIndex: 0 }),
    },
  );
}

export function flushAcpMessage(activity, emit) {
  if (!activity.pendingMessage) return;
  appendText(
    activity,
    "message",
    visibleAcpMessage(activity.pendingMessage),
    emit,
  );
  activity.pendingMessage = undefined;
}

function toolResult(update, previous) {
  const content = update.content?.flatMap((part) => {
    if (part.content?.type === "text" && !part.content.text) return [];
    if (part.content) return [part.content];
    return part.diff ? [{ type: "text", text: part.diff }] : [];
  });
  if (content?.length) return { content };
  const raw = update.rawOutput;
  const text = typeof raw === "string" ? raw : raw?.output;
  if (typeof text === "string" && text.trim())
    return { content: [{ type: "text", text }] };
  return previous?.result;
}

export function applyAcpUpdate(activity, update, emit) {
  const { turn } = activity;
  const kind = update.sessionUpdate;
  if (
    kind === "session_config_options_update" ||
    kind === "config_option_update"
  ) {
    activity.onConfig?.(update);
    return;
  }
  if (kind === "usage_update") {
    const tokenUsage = measureAgyUsage(activity, update);
    if (tokenUsage)
      emit("thread/tokenUsage/updated", { turnId: turn.id, tokenUsage });
    return;
  }
  if (
    kind === "notice" &&
    ["error", "fatal"].includes(update.level ?? update.severity)
  ) {
    activity.error = update.message || update.content?.text;
    return;
  }
  if (kind === "agent_thought_chunk") {
    appendText(activity, "thought", update.content?.text, emit);
    return;
  }
  if (kind === "agent_message_chunk") {
    const chunk = update.content?.text;
    if (!chunk) return;
    if (activity.message) appendText(activity, "message", chunk, emit);
    else {
      const pending = (activity.pendingMessage || "") + chunk;
      const visible = visibleAcpMessage(pending, false);
      activity.pendingMessage = visible === null ? pending : undefined;
      appendText(activity, "message", visible, emit);
    }
    return;
  }
  if (!["tool_call", "tool_call_update"].includes(kind)) return;
  if (kind === "tool_call") flushAcpMessage(activity, emit);
  if (kind === "tool_call" && activity.message) {
    emit("item/completed", {
      turnId: turn.id,
      item: { ...activity.message, phase: "commentary" },
    });
    activity.message.phase = "commentary";
    activity.message = undefined;
  }
  const previous = turn.items.find(({ id }) => id === update.toolCallId);
  const exitCode = update.rawOutput?.exit_code;
  const item = {
    id: update.toolCallId,
    type: "mcpToolCall",
    server: "agy",
    tool: update.title || previous?.tool || update.kind || "工具",
    status:
      update.status === "completed" &&
      Number.isInteger(exitCode) &&
      exitCode !== 0
        ? "failed"
        : update.status === "in_progress"
          ? "inProgress"
          : update.status || previous?.status,
    arguments: update.rawInput ?? previous?.arguments,
    result: toolResult(update, previous),
    ...(Number.isInteger(exitCode) &&
      exitCode !== 0 && { error: `命令退出码 ${exitCode}` }),
  };
  put(turn, item, emit);
  const changes = acpFileChanges(update, activity.session.cwd);
  const fileItemId = update.toolCallId + "-files";
  if (
    !previous ||
    (changes.length && !turn.items.some(({ id }) => id === fileItemId))
  )
    activity.thought = undefined;
  if (changes.length)
    put(
      turn,
      {
        id: fileItemId,
        type: "fileChange",
        status: "completed",
        changes,
      },
      emit,
    );
}

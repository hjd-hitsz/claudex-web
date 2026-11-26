import { acpFileChanges } from "./acp-files.mjs";
import { randomUUID } from "node:crypto";

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
    activity.usage = update;
    return;
  }
  if (kind === "compaction" || kind === "session_compaction") {
    activity.compacted = true;
    return;
  }
  if (
    kind === "notice" &&
    ["error", "fatal"].includes(update.level ?? update.severity)
  ) {
    activity.error = update.message || update.content?.text;
    return;
  }
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const text = update.content?.text;
    if (!text) return;
    const field = kind === "agent_message_chunk" ? "message" : "thought";
    const type = field === "message" ? "agentMessage" : "reasoning";
    if (!activity[field]) {
      const item = {
        id: randomUUID(),
        type,
        ...(field === "message"
          ? { text: "", phase: "final_answer" }
          : { summary: [""] }),
      };
      activity[field] = item;
      turn.items.push(item);
      emit("item/started", { turnId: turn.id, item });
    }
    const item = activity[field];
    if (field === "message") item.text += text;
    else item.summary[0] += text;
    emit(
      field === "message"
        ? "item/agentMessage/delta"
        : "item/reasoning/summaryTextDelta",
      {
        itemId: item.id,
        turnId: turn.id,
        delta: text,
        ...(field === "thought" && { summaryIndex: 0 }),
      },
    );
    return;
  }
  if (!["tool_call", "tool_call_update"].includes(kind)) return;
  if (kind === "tool_call" && activity.message) {
    emit("item/completed", {
      turnId: turn.id,
      item: { ...activity.message, phase: "commentary" },
    });
    activity.message.phase = "commentary";
    activity.message = undefined;
  }
  const previous = turn.items.find(({ id }) => id === update.toolCallId);
  const item = {
    id: update.toolCallId,
    type: "mcpToolCall",
    server: "agy",
    tool: update.title || previous?.tool || update.kind || "工具",
    status:
      update.status === "in_progress"
        ? "inProgress"
        : update.status || previous?.status,
    arguments: update.rawInput ?? previous?.arguments,
    result: update.content
      ? {
          content: update.content.map(
            (part) => part.content || { type: "text", text: part.diff || "" },
          ),
        }
      : previous?.result,
  };
  put(turn, item, emit);
  const changes = acpFileChanges(update, activity.session.cwd);
  if (changes.length)
    put(
      turn,
      {
        id: update.toolCallId + "-files",
        type: "fileChange",
        status: "completed",
        changes,
      },
      emit,
    );
}

import { projectInstructionFrame } from "./project-instructions.mjs";
import { secretarySystem } from "./secretary-system.mjs";

function moveSystemMessages(history, system) {
  const messages = [];
  for (const message of history) {
    if (message.role !== "system") {
      messages.push(message);
      continue;
    }
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    for (const block of blocks) {
      if (block.type !== "text")
        throw new Error(
          `标准 Messages 系统上下文包含未适配的内容类型：${block.type}`,
        );
      system.push(block);
    }
  }
  return messages;
}

function keepToolGroupsTogether(messages) {
  let reordered;
  for (let index = 0; index < messages.length; index++) {
    const { role, content } = messages[index];
    if (role !== "assistant" || !Array.isArray(content)) continue;
    const pending = new Set(
      content.filter(({ type }) => type === "tool_use").map(({ id }) => id),
    );
    if (!pending.size) continue;
    const systems = [];
    const results = [];
    let end = index + 1;
    for (; end < messages.length && pending.size; end++) {
      const next = messages[end];
      if (next.role === "system") {
        systems.push(next);
        continue;
      }
      if (next.role !== "user" || !Array.isArray(next.content)) break;
      const previousCount = pending.size;
      for (const block of next.content)
        if (block.type === "tool_result") pending.delete(block.tool_use_id);
      if (pending.size === previousCount) break;
      results.push(next);
    }
    if (pending.size || !systems.length) continue;
    reordered ??= messages.slice();
    let position = index + 1;
    for (const result of results) reordered[position++] = result;
    for (const message of systems) reordered[position++] = message;
    index = end - 1;
  }
  return reordered ?? messages;
}

function latestSystemInstructions(system, secretary) {
  let hasCurrentInstructions = false;
  return system
    .toReversed()
    .flatMap((block) => {
      if (block === secretary) return [block];
      const frame = projectInstructionFrame(block.text);
      if (!frame) return [block];
      if (!hasCurrentInstructions) {
        hasCurrentInstructions = true;
        return [block];
      }
      const text =
        block.text.slice(0, frame.start) + block.text.slice(frame.end);
      return text.trim() ? [{ ...block, text }] : [];
    })
    .reverse();
}

export function messagesRequest(
  value,
  { standard = true, secretaryRole } = {},
) {
  if (!Array.isArray(value.messages) || (!standard && !secretaryRole))
    return value;
  const system =
    typeof value.system === "string"
      ? [{ type: "text", text: value.system }]
      : [...(value.system || [])];
  const secretary =
    secretaryRole &&
    system.find(
      (block) =>
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim() === secretaryRole.trim(),
    );
  if (!standard && !secretary) return value;
  const messages = standard
    ? moveSystemMessages(value.messages, system)
    : keepToolGroupsTogether(value.messages);
  const currentSystem = latestSystemInstructions(system, secretary);
  // Anthropic 省略 thinking 表示关闭；明确传递该语义，保留原生主请求的 adaptive。
  const result = {
    ...value,
    messages,
    ...(standard &&
      value.thinking === undefined && { thinking: { type: "disabled" } }),
    ...(system.length && {
      system: secretary
        ? secretarySystem(currentSystem, secretary)
        : currentSystem,
    }),
  };
  return result;
}

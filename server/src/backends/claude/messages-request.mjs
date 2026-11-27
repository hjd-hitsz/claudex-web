import { projectInstructionFrame } from "./project-instructions.mjs";
import { secretarySystem } from "./secretary-system.mjs";

// 标准 Messages 端点通过顶层 system 接收系统上下文，指令优先级保持为系统级。
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
  const messages = [];
  for (const message of value.messages) {
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
  // Preserve unrelated native context within the same system block.
  let hasCurrentInstructions = false;
  const currentSystem = system
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

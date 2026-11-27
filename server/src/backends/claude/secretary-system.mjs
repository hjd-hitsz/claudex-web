import layout from "./sdk-system-layout.json" with { type: "json" };
import { projectInstructionFrame } from "./project-instructions.mjs";

function withoutAgentTypes(text) {
  const boundary = projectInstructionFrame(text)?.start ?? text.length;
  const lines = text.slice(0, boundary).split("\n");
  if (lines[0].trimEnd() !== layout.environmentHeading) return text;
  const heading = lines.findIndex(
    (line) => line.trimEnd() === layout.agentTypesHeading,
  );
  if (heading < 0 || !lines[heading + 1]?.startsWith("- ")) return text;
  const nextSection = lines.findIndex(
    (line, index) => index > heading && !/^(?:- |\s+\S)/.test(line),
  );
  lines.splice(
    heading,
    (nextSection < 0 ? lines.length : nextSection) - heading,
  );
  return lines.join("\n") + text.slice(boundary);
}

export function secretarySystem(system, role) {
  const position = system.indexOf(role);
  const context = system.flatMap((block, index) => {
    if (block === role) return [];
    if (block.type !== "text" || typeof block.text !== "string")
      throw new Error("Claude 秘书系统上下文须使用文本块");
    const text = block.text;
    if (
      index < position &&
      (text.trim() === layout.identityBlock ||
        (index === 0 &&
          text.startsWith(layout.billingPrefix) &&
          !text.includes("\n")))
    )
      return [];
    return [{ ...block, text: withoutAgentTypes(text) }];
  });
  const last = context.at(-1) ?? role;
  return [
    {
      type: "text",
      text: [role.text, ...context.map(({ text }) => text)].join("\n\n"),
      ...(last.cache_control && { cache_control: last.cache_control }),
    },
  ];
}

export function deliverySnippet(text) {
  if (typeof text !== "string") return "";
  const plain = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const characters = [...plain];
  return characters.length > 78
    ? characters.slice(0, 75).join("").trimEnd() + "..."
    : plain;
}

export function delegationSnippet(text) {
  return deliverySnippet(
    text
      .replace(/^\s*#{1,6}\s+.*$/gm, "")
      .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, "$1")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1"),
  );
}

export function delegationPreview(answer) {
  if (typeof answer !== "string") return "";
  const sections = answer.split(
    /^\*\*(阶段说明|最终结论|计划|回复)\*\*[ \t]*$/m,
  );
  const final = sections.lastIndexOf("最终结论");
  return final !== -1
    ? delegationSnippet(sections[final + 1])
    : sections.length === 1
      ? delegationSnippet(answer)
      : "";
}

import { replaceMarkdownMarkers } from "./markdown-markers.js";

export function parseAnnotations(text) {
  const match =
    /^\s*# Response annotations:\r?\n[\s\S]*?\r?\n<response-annotations>\r?\n([\s\S]*?)\r?\n<\/response-annotations>(?:\r?\n|$)/.exec(
      text || "",
    );
  if (!match) return { text, annotations: [] };
  try {
    const annotations = JSON.parse(match[1]);
    if (
      !Array.isArray(annotations) ||
      !annotations.length ||
      !annotations.every(
        (entry) =>
          entry &&
          typeof entry.text === "string" &&
          entry.text.trim() &&
          (entry.annotation === undefined ||
            typeof entry.annotation === "string"),
      )
    )
      return { text, annotations: [] };
    return {
      text: text
        .slice(match[0].length)
        .replace(/^\s*## My request(?: for Codex)?:\s*\n/, "")
        .trim(),
      annotations,
    };
  } catch {
    return { text, annotations: [] };
  }
}

export function annotationMessage(
  annotations,
  request = "请根据这些注释继续处理。",
) {
  const payload = JSON.stringify(
    annotations.map(({ text, annotation, source }) => ({
      text,
      annotation,
      source,
    })),
  )
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return `\n# Response annotations:\n以下各项是用户选自较早回复的原文及批注，按数组顺序编号为 1、2 等。请结合原文处理每条批注，并在回复中对应位置加入行内标记 :codex-annotation{index="N"}，其中 N 为该项从 1 开始的编号。\n<response-annotations>\n${payload}\n</response-annotations>\n\n## My request:\n${request}`;
}

export function annotationContexts(items) {
  const turns = new Map(),
    contexts = new Map();
  let latest = [];
  for (const item of items) {
    if (item.type === "userMessage") {
      latest = (item.content || [])
        .filter((content) => content.type === "text")
        .flatMap((content) => parseAnnotations(content.text).annotations);
      if (item.turnId) turns.set(item.turnId, latest);
    } else if (item.type === "agentMessage") {
      contexts.set(
        item.id,
        item.turnId ? turns.get(item.turnId) || [] : latest,
      );
    }
  }
  return contexts;
}

export function remarkAnnotations() {
  return (root) =>
    replaceMarkdownMarkers(root, function* (value) {
      for (const match of value.matchAll(
        /:codex-annotation\{index=["']([1-9]\d*)["']\}/g,
      )) {
        if (!Number.isSafeInteger(Number(match[1]))) continue;
        yield {
          start: match.index,
          end: match.index + match[0].length,
          replacement: {
            type: "annotationReference",
            data: { hName: "annotation-ref", hProperties: { index: match[1] } },
          },
        };
      }
    });
}

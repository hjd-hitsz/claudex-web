import {
  CODE_LINE_FILE_LIMIT,
  isCodeLineSnippet,
} from "../../../shared/code-line-reference.mjs";
import { uid } from "./format.js";

const legacyHeading = "粘贴代码的匹配文件候选：\n";
const sourceHeading =
  "粘贴代码已定位。需要源码上下文时，请直接读取以下绝对路径和行号。";
const candidateHeading =
  "同一段粘贴代码匹配到多处。需要源码上下文时，请直接读取以下候选位置并核对。";
const sourceId = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const sourceIdPattern = new RegExp(`^${sourceId}$`, "i");
const sourceMarkers = new RegExp(
  `<!--claudex-code-source:${sourceId}-->|(\`{3,}[^\\r\\n]*? claudex-paste(?: before)?(?: after)?) source=${sourceId}$`,
  "gim",
);

export function isCodeSourceId(id) {
  return typeof id === "string" && sourceIdPattern.test(id);
}

// 匹配结果异步更新源码标记，发送确认按可见正文判断草稿是否已更改。
export function sameDraftText(current, submitted) {
  return (
    current === submitted ||
    (typeof current === "string" &&
      current.replace(sourceMarkers, "$1") ===
        submitted.replace(sourceMarkers, "$1"))
  );
}

export function codeLineKey({ code, matches }) {
  return JSON.stringify([
    code,
    matches.map(({ path, line }) => JSON.stringify([path, line])).sort(),
  ]);
}

export function codeLineContext({ matches }) {
  return [
    matches.length === 1 ? sourceHeading : candidateHeading,
    ...matches.map(({ path, line }) => `- ${path}:${line}`),
  ].join("\n");
}

export function codeLineAttachment(code, matches, id = uid(), anchors = []) {
  if (
    !isCodeLineSnippet(code) ||
    !Array.isArray(matches) ||
    !matches.length ||
    matches.length > CODE_LINE_FILE_LIMIT ||
    !matches.every(
      (match) =>
        typeof match?.path === "string" &&
        match.path.startsWith("/") &&
        !match.path.startsWith("//") &&
        !/[\r\n\0]/.test(match.path) &&
        Number.isSafeInteger(match.line) &&
        match.line > 0,
    ) ||
    new Set(matches.map((match) => match.path)).size !== matches.length ||
    !Array.isArray(anchors) ||
    !anchors.every(isCodeSourceId)
  )
    return null;
  return {
    kind: "code-line",
    id,
    code,
    matches,
    anchors,
    input: {
      type: "text",
      text: `\n\n${codeLineContext({ matches })}\n\n${JSON.stringify({ code, ...(anchors.length && { anchors }) })}\n\n`,
      text_elements: [],
    },
  };
}

export function readCodeLineAttachment(input, index) {
  if (input.type !== "text" || typeof input.text !== "string") return null;
  const id = `code-line-${index}`;
  try {
    const text = input.text.trim();
    if (text.startsWith(legacyHeading)) {
      const { code, matches, anchors } = JSON.parse(
        text.slice(legacyHeading.length),
      );
      return codeLineAttachment(code, matches, id, anchors);
    }
    if (!text.startsWith(sourceHeading) && !text.startsWith(candidateHeading))
      return null;
    const [context, metadata, trailing] = text.split("\n\n");
    const [heading, ...locations] = context.split("\n");
    if (
      trailing !== undefined ||
      heading !== (locations.length === 1 ? sourceHeading : candidateHeading)
    )
      return null;
    const matches = locations.map((location) => {
      const match = /^- (\/.*):([1-9]\d*)$/.exec(location);
      return match && { path: match[1], line: Number(match[2]) };
    });
    const { code, anchors } = JSON.parse(metadata);
    return codeLineAttachment(code, matches, id, anchors);
  } catch {
    return null;
  }
}

import {
  CODE_LINE_FILE_LIMIT,
  isCodeLineSnippet,
} from "../../../shared/code-line-reference.mjs";
import { uid } from "./format.js";

const heading = "粘贴代码的匹配文件候选：\n";
const sourceIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function isCodeSourceId(id) {
  return typeof id === "string" && sourceIdPattern.test(id);
}

export function codeLineKey({ code, matches }) {
  return JSON.stringify([
    code,
    matches.map(({ path, line }) => JSON.stringify([path, line])).sort(),
  ]);
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
      text:
        heading +
        JSON.stringify({ code, matches, ...(anchors.length && { anchors }) }),
      text_elements: [],
    },
  };
}

export function readCodeLineAttachment(input, index) {
  if (
    input.type !== "text" ||
    typeof input.text !== "string" ||
    !input.text.startsWith(heading)
  )
    return null;
  try {
    const { code, matches, anchors } = JSON.parse(
      input.text.slice(heading.length),
    );
    return codeLineAttachment(code, matches, `code-line-${index}`, anchors);
  } catch {
    return null;
  }
}

import { markdownFromRange } from "../markdown/markdown-selection.js";

function withoutSpaces(text) {
  return text.replace(/\s/g, "");
}

function legacyMathText(text) {
  return withoutSpaces(text.normalize("NFKC")).replaceAll("\u200b", "");
}

export function annotationRoot(messageId, scope = globalThis.document) {
  if (typeof messageId !== "string" || !scope) return null;
  return [...scope.querySelectorAll("[data-annotation-message]")].find(
    (node) => node.dataset.annotationMessage === messageId,
  );
}

// 来源偏移按已渲染回复的 UTF-16 文本计数，包括隐藏节点。
export function sourceRange(root, entry) {
  if (!root) return null;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4);
  const nodes = [];
  let node;
  let text = "";
  while ((node = walker.nextNode())) {
    nodes.push({ node, start: text.length });
    text += node.textContent;
  }

  function interval(start, end) {
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start
    )
      return null;
    const first = nodes.find(
      ({ node, start: offset }) => offset + node.length > start,
    );
    const last = nodes.find(
      ({ node, start: offset }) => offset < end && offset + node.length >= end,
    );
    if (!first || !last) return null;
    const range = doc.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    return range;
  }

  const expected = entry.anchorText ?? entry.text;
  const normalized = withoutSpaces(expected);
  if (!normalized) return null;
  const { startOffset, endOffset } = entry.source || {};
  const stored = interval(startOffset, endOffset);
  if (stored) {
    if (withoutSpaces(stored.toString()) === normalized) return stored;
    if (entry.anchorText === undefined) {
      const fragment = stored.cloneContents();
      const annotations = fragment.querySelectorAll(
        'annotation[encoding="application/x-tex"]',
      );
      if (annotations.length) {
        for (const annotation of annotations) annotation.remove();
        if (legacyMathText(fragment.textContent) === legacyMathText(expected))
          return stored;
      }
    }
  }
  const characters = [...text.matchAll(/\S/g)];
  const index = characters
    .map(([character]) => character)
    .join("")
    .indexOf(normalized);
  return index < 0
    ? null
    : interval(
        characters[index].index,
        characters[index + normalized.length - 1].index + 1,
      );
}

export function annotationQuote(entry, scope) {
  const root = annotationRoot(entry.source?.messageId, scope);
  const range = sourceRange(root, entry);
  if (!range) return entry.text;
  return (
    markdownFromRange(range, root.querySelector("[data-markdown-selection]")) ||
    entry.text
  );
}

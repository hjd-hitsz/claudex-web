import { fromDom } from "hast-util-from-dom";
import { toMdast } from "hast-util-to-mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { mathToMarkdown } from "mdast-util-math";
import { toMarkdown } from "mdast-util-to-markdown";

const markdownRoot = "[data-markdown-selection]";
const texSource = 'annotation[encoding="application/x-tex"]';

const conversion = {
  document: true,
  handlers: {
    "markdown-formula": (_state, node) => ({
      type: node.properties.dataDisplay ? "math" : "inlineMath",
      value: node.properties.dataSource,
    }),
  },
};

const serialization = {
  bullet: "-",
  fences: true,
  extensions: [gfmToMarkdown(), mathToMarkdown()],
};

function element(node) {
  return node.nodeType === 1 ? node : node.parentElement;
}

function formulaContaining(node) {
  const container = element(node);
  return container?.closest(".katex-display") || container?.closest(".katex");
}

function selectedFragment(range, root) {
  const slice = range.cloneRange();
  if (!root.contains(slice.startContainer)) slice.setStart(root, 0);
  if (!root.contains(slice.endContainer))
    slice.setEnd(root, root.childNodes.length);

  const firstFormula = formulaContaining(slice.startContainer);
  const lastFormula = formulaContaining(slice.endContainer);
  if (firstFormula) slice.setStartBefore(firstFormula);
  if (lastFormula) slice.setEndAfter(lastFormula);
  if (slice.collapsed) return null;

  const fragment = slice.cloneContents();
  // 补回 cloneContents 省略的共同祖先，保留部分选区的链接和行内格式。
  for (
    let ancestor = element(slice.commonAncestorContainer);
    ancestor && ancestor !== root;
    ancestor = ancestor.parentElement
  ) {
    const wrapper = ancestor.cloneNode(false);
    wrapper.append(fragment);
    fragment.append(wrapper);
  }
  return fragment;
}

function prepareFragment(fragment) {
  for (const details of fragment.querySelectorAll("details:not([open])")) {
    const summary = details.querySelector(":scope > summary");
    details.replaceWith(...(summary?.childNodes || []));
  }
  for (const node of fragment.querySelectorAll(
    ".code-heading, .annotation-reference, .mermaid-status, [hidden]",
  ))
    node.remove();

  for (const formula of fragment.querySelectorAll(
    ".katex-display, .katex:not(.katex-display .katex)",
  )) {
    const value = formula.querySelector(texSource)?.textContent;
    if (value === undefined) continue;
    const math = fragment.ownerDocument.createElement("markdown-formula");
    math.dataset.source = value;
    if (formula.classList.contains("katex-display"))
      math.dataset.display = "true";
    formula.replaceWith(math);
  }

  for (const link of fragment.querySelectorAll("a[data-markdown-href]")) {
    link.setAttribute("href", link.dataset.markdownHref);
    if (link.hasAttribute("data-markdown-title"))
      link.setAttribute("title", link.dataset.markdownTitle);
    else link.removeAttribute("title");
  }

  for (const image of fragment.querySelectorAll("img[data-markdown-src]")) {
    image.setAttribute("src", image.dataset.markdownSrc);
  }

  for (const diagram of fragment.querySelectorAll("[data-mermaid-source]")) {
    const code = fragment.ownerDocument.createElement("code");
    code.className = "language-mermaid";
    code.textContent = diagram.dataset.mermaidSource;
    const pre = fragment.ownerDocument.createElement("pre");
    pre.append(code);
    diagram.replaceWith(pre);
  }
}

export function markdownFromRange(range, root) {
  if (!root || !range.intersectsNode(root)) return "";
  const fragment = selectedFragment(range, root);
  if (!fragment) return "";
  prepareFragment(fragment);
  return toMarkdown(
    toMdast(fromDom(fragment), conversion),
    serialization,
  ).trimEnd();
}

function copyMarkdownSelection(event) {
  if (event.defaultPrevented || !event.clipboardData) return;
  const doc = event.currentTarget;
  if (event.target.closest?.("textarea, input")) return;
  const selection = doc.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const start = element(range.startContainer);
  const end = element(range.endContainer);
  if (start?.isContentEditable || end?.isContentEditable) return;
  const first = start?.closest(markdownRoot);
  const last = end?.closest(markdownRoot);
  const scope = start?.closest(".message-column, .subagent-history");
  const roots =
    first && first === last
      ? [first]
      : scope?.contains(end)
        ? [...scope.querySelectorAll(markdownRoot)].filter(
            (root) => root.getClientRects().length,
          )
        : [];
  const markdown = roots
    .map((root) => markdownFromRange(range, root))
    .filter(Boolean)
    .join("\n\n");
  if (!markdown) return;
  event.clipboardData.setData("text/plain", markdown);
  event.preventDefault();
}

export function listenForMarkdownCopy() {
  document.addEventListener("copy", copyMarkdownSelection);
  return () => document.removeEventListener("copy", copyMarkdownSelection);
}

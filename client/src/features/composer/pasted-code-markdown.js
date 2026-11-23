import { $remark } from "@milkdown/kit/utils";
import { inlineCodeSchema } from "@milkdown/kit/preset/commonmark";
import { isCodeSourceId } from "../../domain/code-line-reference.js";

const pasteMeta =
  /^claudex-paste(?: (before))?(?: (after))?(?: source=(\S+))?$/;
const sourceComment = /^<!--claudex-code-source:(\S+)-->$/;

export function configureInlineCodeSources(ctx) {
  ctx.update(inlineCodeSchema.key, (schema) => (ctx) => {
    const spec = schema(ctx);
    return {
      ...spec,
      attrs: { ...spec.attrs, sourceId: { default: null } },
      parseMarkdown: {
        ...spec.parseMarkdown,
        runner(state, node, mark) {
          state.openMark(mark, { sourceId: node.sourceId ?? null });
          state.addText(node.value);
          state.closeMark(mark);
        },
      },
      toMarkdown: {
        ...spec.toMarkdown,
        runner(state, mark, node) {
          state.withMark(mark, "inlineCode", node.text || "", {
            sourceId: mark.attrs.sourceId,
          });
          return true;
        },
      },
    };
  });
}

export function pastedCodeText(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /[^ \t]/.test(line));
  if (start < 0) return "";
  const end = lines.findLastIndex((line) => /[^ \t]/.test(line));
  return lines.slice(start, end + 1).join("\n");
}

function isTextBlock(node) {
  return node?.type === "paragraph" || node?.type === "heading";
}

function restoreInlineCode(node) {
  if (!node.children) return;
  const children = [];
  for (let index = 0; index < node.children.length; index++) {
    const child = node.children[index];
    const sourceId =
      child.type === "html" && sourceComment.exec(child.value)?.[1];
    if (isCodeSourceId(sourceId) && children.at(-1)?.type === "inlineCode") {
      children.at(-1).sourceId = sourceId;
      continue;
    }
    const match = child.type === "code" && pasteMeta.exec(child.meta);
    if (!match) {
      restoreInlineCode(child);
      children.push(child);
      continue;
    }
    const [, before, after, id] = match;
    let paragraph = before && children.at(-1);
    if (!isTextBlock(paragraph)) {
      paragraph = { type: "paragraph", children: [] };
      children.push(paragraph);
    }
    (paragraph.children ??= []).push({
      type: "pastedCode",
      value: pastedCodeText(child.value ?? ""),
      lang: child.lang,
      sourceId: isCodeSourceId(id) ? id : null,
    });
    const next = node.children[index + 1];
    if (after && isTextBlock(next)) {
      restoreInlineCode(next);
      paragraph.children.push(...(next.children ?? []));
      index++;
    }
  }
  node.children = children;
}

function preserveBoundarySpace(children, startsAfterFence, endsBeforeFence) {
  const first = children[0];
  const leading =
    startsAfterFence &&
    first.type === "text" &&
    first.value.match(/^[ \t]+/)?.[0];
  if (leading)
    children = [
      { ...first, value: first.value.slice(leading.length) },
      ...children.slice(1),
    ];
  const last = children.at(-1);
  const trailing =
    endsBeforeFence && last.type === "text" && last.value.match(/[ \t]+$/)?.[0];
  if (trailing)
    children = [
      ...children.slice(0, -1),
      { ...last, value: last.value.slice(0, -trailing.length) },
    ];
  return [
    ...(leading ? [{ type: "pastedSpace", value: leading }] : []),
    ...children,
    ...(trailing ? [{ type: "pastedSpace", value: trailing }] : []),
  ];
}

function toFencedCode(node) {
  if (!node.children) return node;
  const children = node.children.flatMap((child) => {
    if (child.type === "inlineCode" && isCodeSourceId(child.sourceId))
      return [
        child,
        { type: "html", value: `<!--claudex-code-source:${child.sourceId}-->` },
      ];
    if (
      !isTextBlock(child) ||
      !child.children?.some((inline) => inline.type === "pastedCode")
    )
      return [toFencedCode(child)];
    const blocks = [];
    let inline = [];
    let followsCode = false;
    const flush = (precedesCode) => {
      if (inline.length)
        blocks.push(
          toFencedCode({
            ...child,
            children: preserveBoundarySpace(inline, followsCode, precedesCode),
          }),
        );
      inline = [];
    };
    child.children.forEach((item, index) => {
      if (item.type !== "pastedCode") {
        inline.push(item);
        return;
      }
      flush(true);
      blocks.push({
        type: "code",
        value: item.value,
        lang: item.lang,
        meta:
          "claudex-paste" +
          (index > 0 ? " before" : "") +
          (index < child.children.length - 1 ? " after" : "") +
          (isCodeSourceId(item.sourceId) ? " source=" + item.sourceId : ""),
      });
      followsCode = true;
    });
    flush(false);
    return blocks;
  });
  return { ...node, children };
}

// 草稿内部使用行内节点。聊天历史沿用标准 Markdown 围栏，标记用于恢复插入位置。
export const pastedCodeMarkdown = $remark(
  "pastedCodeMarkdown",
  () =>
    function () {
      this.data().toMarkdownExtensions.push({
        handlers: {
          root: (node, _parent, state, info) =>
            state.containerFlow(toFencedCode(node), info),
          pastedSpace: (node) =>
            Array.from(
              node.value,
              (letter) => `&#${letter.charCodeAt(0)};`,
            ).join(""),
        },
      });
      return restoreInlineCode;
    },
);

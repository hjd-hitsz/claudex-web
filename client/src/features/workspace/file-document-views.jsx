import React from "react";
import { createRoot } from "react-dom/client";
import { $view, $prose, $remark } from "@milkdown/kit/utils";
import {
  NodeSelection,
  Plugin,
  TextSelection,
} from "@milkdown/kit/prose/state";
import {
  codeBlockSchema,
  htmlSchema,
  imageSchema,
  linkSchema,
  sanitizeLinkHref,
} from "@milkdown/kit/preset/commonmark";
import { RichText } from "../markdown/rich-text.jsx";
import { MessageImage } from "../markdown/message-image.jsx";
import { localImagePath } from "../../domain/image-source.js";
import { set } from "../../store.js";
import { pathIcon } from "../../ui/path-icon.jsx";

const inlineHtml = $remark("fileInlineHtml", () => () => (tree, file) => {
  function htmlSource(node) {
    if (node.type === "html") return node.value;
    if (
      node.type === "paragraph" &&
      node.children?.length === 1 &&
      node.children[0].type === "html"
    )
      return node.children[0].value;
    return "";
  }
  function group(node) {
    const children = node.children || [];
    children.forEach(group);
    for (let index = 0; index < children.length; index++) {
      const first = children[index];
      const source = htmlSource(first);
      const tag = source.match(/^<([a-z][\w:-]*)(?:\s[^<>]*)?>/i)?.[1];
      if (
        !tag ||
        /\/>$/.test(source) ||
        /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(
          tag,
        )
      )
        continue;
      const tags = new RegExp(`<(/?)${tag}(?:\\s[^<>]*)?>`, "gi");
      let depth = 0;
      for (const match of source.matchAll(tags)) depth += match[1] ? -1 : 1;
      if (depth <= 0) continue;
      for (let end = index + 1; end < children.length; end++) {
        const last = children[end];
        for (const match of htmlSource(last).matchAll(tags))
          depth += match[1] ? -1 : 1;
        if (depth) continue;
        const html = {
          type: "html",
          value: String(file.value).slice(
            first.position.start.offset,
            last.position.end.offset,
          ),
          position: { start: first.position.start, end: last.position.end },
        };
        children.splice(
          index,
          end - index + 1,
          first.type === "paragraph"
            ? { type: "paragraph", children: [html], position: html.position }
            : html,
        );
        break;
      }
    }
  }
  group(tree);
});

export function fileDocumentViews(cwd) {
  return [
    inlineHtml,
    $view(linkSchema.mark, () => (mark) => {
      const dom = document.createElement("a");
      dom.className = "message-link";
      dom.setAttribute("href", sanitizeLinkHref(mark.attrs.href));
      dom.title = mark.attrs.title || mark.attrs.href;
      const icon = document.createElement("span");
      icon.className = "file-link-icon";
      icon.contentEditable = "false";
      icon.setAttribute("aria-hidden", "true");
      const contentDOM = document.createElement("span");
      dom.append(icon, contentDOM);
      const root = createRoot(icon);
      const Icon = pathIcon(mark.attrs.href);
      root.render(<Icon className="message-link-icon" />);
      return {
        dom,
        contentDOM,
        ignoreMutation: (mutation) =>
          mutation.type !== "selection" && icon.contains(mutation.target),
        destroy: () => queueMicrotask(() => root.unmount()),
      };
    }),
    $view(imageSchema.node, () => (node) => {
      const dom = document.createElement("span");
      dom.className = "markdown file-document-image";
      dom.contentEditable = "false";
      const root = createRoot(dom);
      root.render(<MessageImage {...node.attrs} cwd={cwd} />);
      return {
        dom,
        ignoreMutation: () => true,
        stopEvent: () => true,
        destroy: () => queueMicrotask(() => root.unmount()),
      };
    }),
    $view(htmlSchema.node, () => (node) => {
      const dom = document.createElement("span");
      dom.className =
        /^\s*<(?:p|div|h[1-6]|details|picture|table|ul|ol|blockquote|pre|section|article)\b/i.test(
          node.attrs.value,
        )
          ? "file-document-html-block"
          : "file-document-html-inline";
      dom.contentEditable = "false";
      const root = createRoot(dom);
      root.render(<RichText text={node.attrs.value} cwd={cwd} />);
      return {
        dom,
        ignoreMutation: () => true,
        stopEvent: () => true,
        destroy: () => queueMicrotask(() => root.unmount()),
      };
    }),
    $view(codeBlockSchema.node, () => (node, view, getPos) => {
      const dom = document.createElement("div");
      dom.className = "file-document-code";
      const tools = document.createElement("div");
      tools.contentEditable = "false";
      const button = document.createElement("button");
      button.type = "button";
      const label =
        node.attrs.language?.toLowerCase() === "latex" ? "公式" : "代码";
      button.textContent = "编辑" + label;
      tools.append(button);
      const preview = document.createElement("div");
      preview.contentEditable = "false";
      const pre = document.createElement("pre");
      const contentDOM = document.createElement("code");
      pre.append(contentDOM);
      pre.hidden = true;
      dom.append(tools, preview, pre);
      const root = createRoot(preview);
      let current = node;
      function render() {
        const backticks = current.textContent.match(/`+/g) || [];
        const fence = "`".repeat(
          Math.max(3, ...backticks.map((run) => run.length + 1)),
        );
        root.render(
          <RichText
            text={
              current.attrs.language?.toLowerCase() === "latex"
                ? "$$\n" + current.textContent + "\n$$"
                : fence +
                  (current.attrs.language || "") +
                  "\n" +
                  current.textContent +
                  "\n" +
                  fence
            }
            cwd={cwd}
          />,
        );
      }
      function showSource(visible) {
        pre.hidden = !visible;
        preview.hidden = visible;
        button.textContent = (visible ? "预览" : "编辑") + label;
      }
      button.onclick = () => {
        showSource(pre.hidden);
        const position = getPos();
        if (position !== undefined) {
          view.dispatch(
            view.state.tr.setSelection(
              pre.hidden
                ? NodeSelection.create(view.state.doc, position)
                : TextSelection.create(view.state.doc, position + 1),
            ),
          );
          if (!pre.hidden) view.focus();
        }
      };
      render();
      return {
        dom,
        contentDOM,
        setSelection(anchor, head) {
          showSource(true);
          const text = contentDOM.firstChild || contentDOM;
          view.root.getSelection().setBaseAndExtent(text, anchor, text, head);
        },
        update(next) {
          if (next.type !== current.type) return false;
          current = next;
          render();
          return true;
        },
        stopEvent: (event) =>
          tools.contains(event.target) || preview.contains(event.target),
        ignoreMutation: (mutation) =>
          mutation.type !== "selection" &&
          !contentDOM.contains(mutation.target),
        destroy: () => queueMicrotask(() => root.unmount()),
      };
    }),
    $prose(
      () =>
        new Plugin({
          props: {
            handleDOMEvents: {
              click(view, event) {
                const link = event.target.closest("a[href]");
                if (!link) return false;
                const href = link.getAttribute("href");
                if (href.startsWith("#")) {
                  let id;
                  try {
                    id = decodeURIComponent(href.slice(1));
                  } catch {
                    id = href.slice(1);
                  }
                  const target = [...view.dom.querySelectorAll("[id]")].find(
                    (element) =>
                      element.id === id || element.id === "user-content-" + id,
                  );
                  event.preventDefault();
                  target?.scrollIntoView({ block: "start" });
                  return true;
                }
                const path = localImagePath(href, cwd);
                if (!path) return false;
                event.preventDefault();
                set({
                  panel: "files",
                  panelFile: path.replace(/:\d+(?::\d+)?$/, ""),
                });
                return true;
              },
            },
          },
        }),
    ),
  ];
}

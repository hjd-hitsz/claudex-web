import { Fragment, Slice } from "@milkdown/kit/prose/model";
import { closeHistory } from "@milkdown/kit/prose/history";
import { parserCtx } from "@milkdown/kit/core";
import { syncDocumentSelection } from "./editor-selection.js";
import { resolvePastedCodeLine } from "./document-code-line.js";
import { pastedCodeText } from "./pasted-code-markdown.js";
import { isCodeLineSnippet } from "../../../../shared/code-line-reference.mjs";

// 直接插入解析后的块节点，保留代码围栏及正文两侧的插入边界。
export function insertDocumentMarkdown(view, doc, text) {
  const paragraph = view.state.schema.nodes.paragraph;
  const leading = text.match(/^[ \t]+/)?.[0] || "";
  const trailing = text.match(/[ \t]+$/)?.[0] || "";
  const blocks = [];
  doc.forEach((node, _offset, index) => {
    if (node.type === paragraph) {
      let inline = node.content;
      if (!index && leading && !node.textContent.startsWith(leading))
        inline = Fragment.from(view.state.schema.text(leading)).append(inline);
      if (
        index === doc.childCount - 1 &&
        trailing &&
        !node.textContent.endsWith(trailing)
      )
        inline = inline.append(Fragment.from(view.state.schema.text(trailing)));
      node = node.copy(inline);
    }
    blocks.push(node);
  });
  let content = Fragment.fromArray(blocks);
  if (doc.lastChild?.type !== paragraph)
    content = content.append(Fragment.from(paragraph.create()));
  const slice = new Slice(
    content,
    doc.firstChild?.type === paragraph && !/^\s*\n/.test(text) ? 1 : 0,
    1,
  );
  const tr = closeHistory(view.state.tr).replaceSelection(slice);
  view.dispatch(
    tr.setMeta("paste", true).setMeta("uiEvent", "paste").scrollIntoView(),
  );
  view.dispatch(closeHistory(view.state.tr));
  return true;
}

export function documentPaste(ctx, { mathPaste, inlineCode, findCodeLine }) {
  return (view, event, slice) => {
    const clipboard = event.clipboardData;
    if (!clipboard || !view.editable) return false;
    syncDocumentSelection(view);
    const text = clipboard.getData("text/plain").replace(/\r\n?/g, "\n");
    const html = clipboard.getData("text/html");
    if (!text && !html) return false;
    const { $from } = view.state.selection;
    if (
      $from.parent.type.spec.code ||
      $from.marks().some((m) => m.type.spec.code) ||
      /^[ \t]+$/.test(text)
    ) {
      view.dispatch(
        closeHistory(view.state.tr).insertText(text).scrollIntoView(),
      );
      view.dispatch(closeHistory(view.state.tr));
      return true;
    }
    if (mathPaste?.(view, event)) return true;
    const metadata = clipboard.getData("vscode-editor-data");
    let editorData;
    try {
      editorData = metadata ? JSON.parse(metadata) : null;
    } catch {
      // 无效的编辑器元数据沿用剪贴板中的正文。
    }
    const language = editorData?.mode;
    const hasLanguage = typeof language === "string" && language.length > 0;
    const codeLanguage =
      hasLanguage && !["plaintext", "markdown"].includes(language);
    if (text && (codeLanguage || (!inlineCode && hasLanguage))) {
      const { schema } = view.state;
      if (!inlineCode) {
        const block = schema.nodes.code_block.create(
          { language },
          schema.text(text),
        );
        return insertDocumentMarkdown(
          view,
          schema.topNodeType.create(null, block),
          text,
        );
      }
      const code = pastedCodeText(text);
      const multiline = code.includes("\n");
      const snippet = multiline
        ? schema.nodes.pasted_code.create({ text: code, language })
        : schema.text(
            code || text,
            code.trim() ? [schema.marks.inlineCode.create()] : [],
          );
      view.dispatch(
        closeHistory(view.state.tr)
          .replaceSelectionWith(snippet, false)
          .setMeta("paste", true)
          .setMeta("uiEvent", "paste")
          .scrollIntoView(),
      );
      view.dispatch(closeHistory(view.state.tr));
      if (
        findCodeLine &&
        !editorData.isBlock &&
        !editorData.multicursorText &&
        isCodeLineSnippet(code)
      )
        void resolvePastedCodeLine(view, code, findCodeLine);
      return true;
    }
    // 网页富文本的原生副本保留引用节点及原选区结构。
    if (html && slice?.size) {
      view.dispatch(
        closeHistory(view.state.tr).replaceSelection(slice).scrollIntoView(),
      );
      view.dispatch(closeHistory(view.state.tr));
    } else {
      if (!text) return false;
      const doc = ctx.get(parserCtx)(text);
      if (!doc) return false;
      insertDocumentMarkdown(view, doc, text);
    }
    const code = pastedCodeText(text);
    if (
      inlineCode &&
      findCodeLine &&
      language !== "markdown" &&
      !editorData?.isBlock &&
      !editorData?.multicursorText &&
      !code.includes("\n") &&
      isCodeLineSnippet(code)
    )
      void resolvePastedCodeLine(view, code, findCodeLine, true);
    return true;
  };
}

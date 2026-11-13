import { Fragment, Slice } from "@milkdown/kit/prose/model";
import { closeHistory } from "@milkdown/kit/prose/history";
import { parserCtx } from "@milkdown/kit/core";
import { syncDocumentSelection } from "./editor-selection.js";

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

export function documentPaste(ctx, mathPaste) {
  return (view, event, slice) => {
    const clipboard = event.clipboardData;
    if (!clipboard || !view.editable) return false;
    syncDocumentSelection(view);
    const text = clipboard.getData("text/plain").replace(/\r\n?/g, "\n");
    if (!text && !clipboard.getData("text/html")) return false;
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
    if (mathPaste(view, event)) return true;
    const metadata = clipboard.getData("vscode-editor-data");
    let language;
    try {
      language = metadata ? JSON.parse(metadata).mode : null;
    } catch {
      // 无效的编辑器元数据沿用剪贴板中的正文。
    }
    if (text && typeof language === "string" && language) {
      const { schema } = view.state;
      const code = schema.nodes.code_block.create(
        { language },
        schema.text(text),
      );
      return insertDocumentMarkdown(
        view,
        schema.topNodeType.create(null, code),
        text,
      );
    }
    // 网页富文本的原生副本保留引用节点及原选区结构。
    if (clipboard.getData("text/html") && slice?.size) {
      view.dispatch(
        closeHistory(view.state.tr).replaceSelection(slice).scrollIntoView(),
      );
      view.dispatch(closeHistory(view.state.tr));
      return true;
    }
    if (!text) return false;
    const doc = ctx.get(parserCtx)(text);
    return doc ? insertDocumentMarkdown(view, doc, text) : false;
  };
}

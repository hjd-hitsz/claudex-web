import { closeHistory } from "@milkdown/kit/prose/history";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import { $nodeSchema, $view } from "@milkdown/kit/utils";
import { syncDocumentSelection } from "./editor-selection.js";

export const pastedCodeSchema = $nodeSchema("pasted_code", () => ({
  group: "inline",
  inline: true,
  atom: true,
  attrs: {
    text: { default: "" },
    language: { default: "" },
    sourceId: { default: null },
  },
  leafText: (node) => node.attrs.text,
  parseDOM: [
    {
      tag: "span[data-pasted-code]",
      getAttrs: (dom) => ({
        text: dom.querySelector("code")?.textContent ?? "",
        language: dom.dataset.pastedCode,
      }),
    },
  ],
  toDOM: ({ attrs }) => [
    "span",
    { "data-pasted-code": attrs.language },
    ["code", attrs.text],
  ],
  parseMarkdown: {
    match: (node) => node.type === "pastedCode",
    runner: (state, node, type) =>
      state.addNode(type, {
        text: node.value,
        language: node.lang ?? "",
        sourceId: node.sourceId ?? null,
      }),
  },
  toMarkdown: {
    match: (node) => node.type.name === "pasted_code",
    runner: (state, { attrs }) =>
      state.addNode("pastedCode", undefined, attrs.text, {
        lang: attrs.language,
        sourceId: attrs.sourceId,
      }),
  },
}));

export const pastedCodeView = $view(
  pastedCodeSchema.node,
  () => (node, view, getPos) => {
    const doc = view.dom.ownerDocument;
    const dom = doc.createElement("span");
    dom.className = "pasted-code-entry";
    dom.contentEditable = "false";
    const code = doc.createElement("code");
    code.textContent = node.attrs.text;
    const arrow = doc.createElement("button");
    arrow.type = "button";
    arrow.className = "pasted-code-source";
    arrow.textContent = "↗";
    arrow.setAttribute("aria-label", "移动光标到粘贴代码末尾");
    arrow.title = "粘贴的代码 · 按退格键整段删除";
    arrow.onclick = () => {
      const from = getPos();
      if (from === undefined || !view.editable) return;
      const tr = view.state.tr;
      view.dispatch(
        tr
          .setSelection(TextSelection.create(tr.doc, from + node.nodeSize))
          .scrollIntoView(),
      );
      view.focus();
    };
    dom.append(code, arrow);
    return {
      dom,
      stopEvent: (event) => event.target === arrow,
      ignoreMutation: () => true,
    };
  },
);

export function deletePastedCode(view, event) {
  if (
    view.composing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    !["Backspace", "Delete"].includes(event.key)
  )
    return false;
  const nodeSelected = view.state.selection instanceof NodeSelection;
  if (!nodeSelected) syncDocumentSelection(view);
  const { selection } = view.state;
  if (!selection.empty && !nodeSelected) return false;
  const { $from } = selection;
  const backward = event.key === "Backspace" && !nodeSelected;
  const node = backward ? $from.nodeBefore : $from.nodeAfter;
  if (node?.type.name !== "pasted_code") return false;
  const from = $from.pos - (backward ? node.nodeSize : 0);
  const tr = closeHistory(view.state.tr).delete(from, from + node.nodeSize);
  view.dispatch(tr.scrollIntoView());
  view.dispatch(closeHistory(view.state.tr));
  return true;
}

import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { isCompositionInput } from "./document-composition.js";

function readAnchor(view, range) {
  if (
    !range ||
    !view.dom.contains(range.startContainer) ||
    !view.dom.contains(range.endContainer)
  )
    return null;
  const position = view.state.doc.resolve(
    view.posAtDOM(range.startContainer, range.startOffset),
  );
  if (!position.parent.isTextblock) return null;
  const block = view.nodeDOM(position.before());
  if (
    !block?.contains(range.startContainer) ||
    !block.contains(range.endContainer)
  )
    return null;
  const prefix = view.dom.ownerDocument.createRange();
  prefix.selectNodeContents(block);
  prefix.setEnd(range.startContainer, range.startOffset);
  return { block, start: prefix.toString().length };
}

function readOrigin(view) {
  const selection = view.dom.ownerDocument.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (
    !view.dom.contains(range.startContainer) ||
    !view.dom.contains(range.endContainer)
  )
    return null;
  return {
    doc: view.state.doc,
    marks: view.state.storedMarks,
    from: view.posAtDOM(range.startContainer, range.startOffset),
    to: view.posAtDOM(range.endContainer, range.endOffset),
    anchor: readAnchor(view, range),
  };
}

function restoreMisplacedCommit(view, origin, text, composition) {
  const { doc, from, to, marks } = origin;
  const state = view.state;
  const start = doc.content.findDiffStart(state.doc.content);
  if (start === null) return;
  const changed = doc.resolve(start);
  if (
    !changed.parent.isTextblock ||
    (changed.start() <= to && changed.end() >= from)
  )
    return;

  const removed = text.length + doc.content.size - state.doc.content.size;
  if (removed < 0) return;
  const { b: end } = doc.content.findDiffEnd(state.doc.content);
  const first = Math.max(changed.start(), end - text.length);
  const last = Math.min(start, changed.end() - removed);
  for (let position = first; position <= last; position++) {
    const end = position + text.length;
    if (
      end > state.doc.content.size ||
      !state.doc.resolve(position).sameParent(state.doc.resolve(end)) ||
      state.doc.textBetween(position, end) !== text
    )
      continue;
    const tr = state.tr.replace(
      position,
      end,
      doc.slice(position, position + removed),
    );
    // Verify that restoring this replacement alone recovers the original document.
    if (!tr.doc.eq(doc)) continue;
    tr.setStoredMarks(marks).insertText(text, from, to);
    tr.setSelection(TextSelection.create(tr.doc, tr.mapping.slice(1).map(to)));
    if (composition != null) tr.setMeta("composition", composition);
    view.dispatch(tr.scrollIntoView());
    return;
  }
}

export function documentCompositionSelection() {
  let origin = null;
  let composition;
  let committed;
  let preedit;
  let pending = null;
  let applied = null;

  function clear() {
    origin = null;
    committed = undefined;
    composition = undefined;
    preedit = undefined;
    pending = null;
    applied = null;
  }

  function finish(view, text) {
    const confirmed = committed ?? text;
    if (origin && confirmed)
      restoreMisplacedCommit(view, origin, confirmed, composition);
    clear();
  }

  return {
    finish,
    plugin: new Plugin({
      state: {
        init: () => null,
        apply(tr) {
          if (origin && tr.docChanged && tr.getMeta("composition") != null)
            composition = tr.getMeta("composition");
          return null;
        },
      },
      view(view) {
        const doc = view.dom.ownerDocument;
        const listeners = new AbortController();
        const options = { signal: listeners.signal };

        function keepCaretInComposition() {
          if (!applied || doc.activeElement !== view.dom) return;
          const { block, start, text } = applied;
          const selection = doc.getSelection();
          if (
            !view.dom.contains(block) ||
            !selection?.isCollapsed ||
            block.contains(selection.anchorNode)
          )
            return;
          let offset = start + text.length;
          if (block.textContent.slice(start, offset) !== text) return;
          const nodes = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
          for (let node; (node = nodes.nextNode());) {
            if (offset <= node.length) {
              applied = null;
              selection.collapse(node, offset);
              return;
            }
            offset -= node.length;
          }
        }

        view.dom.addEventListener(
          "compositionstart",
          (event) => {
            if (event.target !== view.dom) return;
            clear();
            origin = readOrigin(view);
          },
          { ...options, capture: true },
        );
        view.dom.addEventListener(
          "compositionupdate",
          (event) => {
            if (event.target === view.dom) preedit = event.data;
          },
          options,
        );
        view.dom.addEventListener(
          "beforeinput",
          (event) => {
            if (event.target !== view.dom) return;
            pending = null;
            applied = null;
            if (!isCompositionInput(event)) return;
            const anchor = readAnchor(view, event.getTargetRanges?.()?.[0]);
            if (
              anchor &&
              (!origin?.anchor || origin.anchor.block === anchor.block)
            ) {
              pending = anchor;
              if (origin) origin.anchor = anchor;
            }
          },
          options,
        );
        view.dom.addEventListener(
          "input",
          (event) => {
            if (event.target !== view.dom) return;
            const anchor = pending ?? origin?.anchor;
            const text = event.data ?? preedit;
            applied =
              anchor && text && isCompositionInput(event)
                ? { ...anchor, text }
                : null;
            pending = null;
            keepCaretInComposition();
          },
          options,
        );
        doc.addEventListener(
          "selectionchange",
          keepCaretInComposition,
          options,
        );
        view.dom.addEventListener(
          "compositionend",
          (event) => {
            if (event.target !== view.dom) return;
            committed = event.data;
            pending = null;
            applied = null;
          },
          options,
        );
        view.dom.addEventListener("pointerdown", clear, options);
        view.dom.addEventListener(
          "blur",
          () => {
            pending = null;
            applied = null;
          },
          options,
        );

        return {
          destroy() {
            listeners.abort();
            clear();
          },
        };
      },
    }),
  };
}

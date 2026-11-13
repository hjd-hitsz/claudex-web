import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { parserCtx } from "@milkdown/kit/core";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import { $inputRule, $prose } from "@milkdown/kit/utils";
import { enterMarkdownTable } from "./document-table-input.js";
import { insertDocumentMarkdown } from "./document-clipboard.js";

export const documentInputRules = $prose(
  (ctx) =>
    new Plugin({
      props: {
        handleTextInput(view, from, to, text) {
          if (
            view.composing ||
            text.length < 2 ||
            !view.state.selection.$from.parent.isTextblock ||
            view.state.selection.$from.parent.type.spec.code ||
            (view.state.storedMarks ?? view.state.selection.$from.marks()).some(
              (mark) => mark.type.spec.code,
            ) ||
            (view.state.selection.$from.parent.content.size &&
              !text.includes("\n")) ||
            !/[\n#*>`$~\[\]-]/.test(text)
          )
            return false;
          const doc = ctx.get(parserCtx)(text);
          if (!doc) return false;
          return insertDocumentMarkdown(view, doc, text);
        },
        handleKeyDown(view, event) {
          if (
            event.key !== "Enter" ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            view.composing
          )
            return false;
          const { state } = view;
          const { $from, empty } = state.selection;
          if (
            !empty ||
            !$from.parent.isTextblock ||
            $from.parent.type.spec.code ||
            $from.parentOffset !== $from.parent.content.size
          )
            return false;
          if (enterMarkdownTable(ctx, view)) return true;
          const text = $from.parent.textContent;
          const fence = /^(?:`{3,}|~{3,})([\w+-]*)$/.exec(text);
          if (!fence) return false;
          const start = $from.start();
          const tr = state.tr
            .delete(start, $from.end())
            .setBlockType(start, start, state.schema.nodes.code_block, {
              language: fence[1],
            });
          view.dispatch(tr.scrollIntoView());
          return true;
        },
      },
      appendTransaction(transactions, _previous, state) {
        if (!transactions.some((tr) => tr.docChanged) || !state.selection.empty)
          return null;
        const { $from } = state.selection;
        if ($from.parent.type.name !== "code_block") return null;
        const text = $from.parent.textContent;
        const match = /\n(?:`{3,}|~{3,})$/.exec(text);
        if (!match || $from.parentOffset !== text.length) return null;
        const from = $from.before();
        const code = $from.parent.type.create(
          $from.parent.attrs,
          text.slice(0, match.index)
            ? state.schema.text(text.slice(0, match.index))
            : null,
        );
        const paragraph = state.schema.nodes.paragraph.create();
        const tr = state.tr.replaceWith(from, from + $from.parent.nodeSize, [
          code,
          paragraph,
        ]);
        return tr
          .setSelection(TextSelection.create(tr.doc, from + code.nodeSize + 1))
          .scrollIntoView();
      },
    }),
);

export const documentLinkRule = $inputRule(
  (ctx) =>
    new InputRule(
      /!?\[([^\]]+)\]\(([^()\s]+)\)$/,
      (state, match, start, end) => {
        const parsed = ctx.get(parserCtx)(match[0]);
        if (!parsed?.firstChild) return null;
        return state.tr.replaceWith(start, end, parsed.firstChild.content);
      },
    ),
);

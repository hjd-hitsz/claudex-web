import { closeHistory } from "@milkdown/kit/prose/history";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import {
  codeLineAttachment,
  codeLineKey,
} from "../../domain/code-line-reference.js";

const sourcesKey = new PluginKey("pastedCodeSources");

function codeRanges(doc) {
  const ranges = [];
  doc.descendants((node, from) => {
    if (node.type.name === "pasted_code") {
      ranges.push({
        from,
        to: from + node.nodeSize,
        node,
        id: node.attrs.sourceId,
        text: node.attrs.text,
      });
    } else if (node.isText) {
      const mark = node.marks.find((mark) => mark.type.name === "inlineCode");
      if (mark)
        ranges.push({
          from,
          to: from + node.nodeSize,
          mark,
          id: mark.attrs.sourceId,
          text: node.text,
        });
    }
  });
  return ranges;
}

function projectSources(doc, registered, previous) {
  const groups = new Map();
  const decorations = [];
  for (const range of codeRanges(doc)) {
    const source = registered.get(range.id);
    if (!source || source.code !== range.text) continue;
    const key = codeLineKey(source);
    const group = groups.get(key) ?? { source, anchors: [], ranges: [] };
    groups.set(key, group);
    if (!group.anchors.includes(range.id)) group.anchors.push(range.id);
    if (range.mark) group.ranges.push(range);
  }
  const old = new Map(previous.map((source) => [codeLineKey(source), source]));
  const attachments = [...groups.entries()].map(
    ([key, { source, anchors, ranges }]) => {
      const prior = old.get(key);
      const attachment =
        prior?.anchors.join() === anchors.join()
          ? prior
          : codeLineAttachment(
              source.code,
              source.matches,
              prior?.id ?? source.id,
              anchors,
            );
      for (const range of ranges)
        decorations.push(...codeSourceDecorations(range, attachment.id));
      return attachment;
    },
  );
  return {
    attachments:
      attachments.length === previous.length &&
      attachments.every((item, index) => item === previous[index])
        ? previous
        : attachments,
    decorations: DecorationSet.create(doc, decorations),
  };
}

export const documentCodeLine = (onSourcesChange) =>
  $prose(
    () =>
      new Plugin({
        key: sourcesKey,
        state: {
          init: () => ({
            pending: DecorationSet.empty,
            decorations: DecorationSet.empty,
            registered: new Map(),
            attachments: [],
          }),
          apply(transaction, state) {
            const { add, remove, register, restore } =
              transaction.getMeta(sourcesKey) ?? {};
            let pending = state.pending.map(
              transaction.mapping,
              transaction.doc,
            );
            if (transaction.docChanged)
              pending = pending.remove(
                pending
                  .find()
                  .filter(
                    ({ from, to, spec }) =>
                      transaction.doc.textBetween(from, to) !== spec.line,
                  ),
              );
            if (remove) pending = pending.remove(remove);
            if (add) pending = pending.add(transaction.doc, [add]);
            const registered =
              restore ??
              (register
                ? new Map([...state.registered, register])
                : state.registered);
            return {
              ...state,
              pending,
              registered,
              ...(transaction.docChanged || register || restore
                ? projectSources(transaction.doc, registered, state.attachments)
                : {}),
            };
          },
        },
        props: {
          decorations: (state) => sourcesKey.getState(state).decorations,
        },
        view: (view) => ({
          update(view, previous) {
            const { attachments, pending } = sourcesKey.getState(view.state);
            const prior = sourcesKey.getState(previous);
            if (attachments !== prior.attachments)
              onSourcesChange?.(attachments);
            if (pending !== prior.pending) {
              const current = new Set(pending.find().map(({ spec }) => spec));
              for (const { spec } of prior.pending.find())
                if (!current.has(spec)) spec.resolve();
            }
          },
          destroy() {
            for (const { spec } of sourcesKey
              .getState(view.state)
              .pending.find())
              spec.resolve();
          },
        }),
      }),
  );

function applySource(tr, range, id) {
  if (range.node) tr.setNodeAttribute(range.from, "sourceId", id);
  else {
    const inlineCode = tr.doc.type.schema.marks.inlineCode;
    tr.addMark(range.from, range.to, inlineCode.create({ sourceId: id }));
  }
}

export async function resolvePastedCodeLine(view, line, lookup, plain = false) {
  const multiline = line.includes("\n");
  const to = view.state.selection.from;
  const from = to - (multiline ? 1 : line.length);
  if (from < 1 || view.state.doc.textBetween(from, to) !== line) return;
  if (plain) {
    let formatted = false;
    view.state.doc.nodesBetween(from, to, (node) => {
      if (node.marks.some((mark) => mark.type.name !== "inlineCode"))
        formatted = true;
    });
    if (formatted) return;
  }
  const pending = { line };
  pending.promise = new Promise((resolve) => {
    pending.resolve = resolve;
  });
  const add = multiline
    ? Decoration.node(from, to, {}, pending)
    : Decoration.inline(from, to, {}, pending);
  view.dispatch(view.state.tr.setMeta(sourcesKey, { add }));
  const matches = await lookup(line).catch(() => []);
  if (view.isDestroyed) return;
  const [range] = sourcesKey
    .getState(view.state)
    .pending.find(undefined, undefined, (spec) => spec === pending);
  if (!range) return;
  const tr = view.state.tr;
  const node = multiline ? tr.doc.nodeAt(range.from) : null;
  const attachment =
    tr.doc.textBetween(range.from, range.to) === line &&
    (!multiline || node?.type.name === "pasted_code")
      ? codeLineAttachment(line, matches)
      : null;
  let register;
  if (attachment) {
    const id = crypto.randomUUID();
    applySource(tr, { ...range, node }, id);
    register = [id, attachment];
  }
  view.dispatch(
    tr
      .setMeta("addToHistory", false)
      .setMeta(sourcesKey, { remove: [range], register }),
  );
}

export function waitForCodeSources(view) {
  const pending = sourcesKey.getState(view.state).pending.find();
  if (!pending.length) return;
  return Promise.all(pending.map(({ spec }) => spec.promise)).then(() => {
    if (view.isDestroyed) return [];
    return (
      waitForCodeSources(view) ?? sourcesKey.getState(view.state).attachments
    );
  });
}

export function restoreCodeSources(view, attachments) {
  const registered = new Map(
    attachments.flatMap((entry) =>
      (entry.anchors ?? []).map((id) => [id, entry]),
    ),
  );
  const legacy = new Map(
    attachments
      .filter((entry) => !entry.anchors?.length)
      .map((entry) => [entry.code, entry]),
  );
  const tr = view.state.tr;
  if (legacy.size) {
    for (const range of codeRanges(tr.doc)) {
      if (range.id && registered.has(range.id)) continue;
      const source = legacy.get(range.text);
      if (!source) continue;
      const id = range.id ?? crypto.randomUUID();
      applySource(tr, range, id);
      registered.set(id, source);
    }
  }
  view.dispatch(
    tr
      .setMeta("addToHistory", false)
      .setMeta(sourcesKey, { restore: registered }),
  );
  // 旧草稿的孤立附件也需要从外层的提交列表中清除。
  return sourcesKey.getState(view.state).attachments;
}

function codeSourceDecorations(range, sourceId) {
  const first = range.from + range.text.length - range.text.trimStart().length;
  return [
    Decoration.inline(first, range.to, { class: "pasted-code-line" }),
    ...(first > range.from
      ? [Decoration.inline(range.from, first, { class: "pasted-code-indent" })]
      : []),
    Decoration.widget(
      range.to,
      (view) => {
        const button = view.dom.ownerDocument.createElement("button");
        button.type = "button";
        button.className = "pasted-code-source";
        button.setAttribute("aria-label", "查看匹配的文件位置");
        button.title = "查看匹配的文件位置";
        button.textContent = "↗";
        button.onclick = () => {
          view.dom
            .closest(".composer, .user-message-editor")
            ?.querySelector(
              '[data-code-file-attachment="' +
                CSS.escape(sourceId) +
                '"] .code-location',
            )
            ?.focus();
        };
        return button;
      },
      {
        side: -1,
        stopEvent: () => true,
        key: "code-source:" + range.id + ":" + sourceId,
      },
    ),
  ];
}

export function removeCodeSource(view, id) {
  const group = sourcesKey
    .getState(view.state)
    .attachments.find((item) => item.id === id);
  if (!group) return false;
  const ids = new Set(group.anchors);
  const tr = closeHistory(view.state.tr);
  for (const range of codeRanges(view.state.doc))
    if (ids.has(range.id)) applySource(tr, range, null);
  view.dispatch(tr);
  view.dispatch(closeHistory(view.state.tr));
  return true;
}

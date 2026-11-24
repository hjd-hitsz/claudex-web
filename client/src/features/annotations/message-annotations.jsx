import React, { useEffect, useRef, useState } from "react";
import { MessageSquare, X } from "lucide-react";
import { createPortal } from "react-dom";
import { set, uid, useStore } from "../../store.js";
import { AnnotationEditor } from "./annotation-editor.jsx";
import {
  useAnnotationDrafts,
  readAnnotationDrafts,
  writeAnnotationDrafts,
  migrateAnnotationDraft,
} from "./annotation-drafts.js";

import { annotationRoot, sourceRange } from "./annotation-selection.js";
import { markdownFromRange } from "../markdown/markdown-selection.js";

function viewportScale() {
  return (
    document.body.getBoundingClientRect().width / document.body.offsetWidth
  );
}

export function MessageAnnotations({ item, children }) {
  const s = useStore();
  const threadId = s.current?.id;
  const entries = useAnnotationDrafts(threadId);
  const content = useRef();
  const [selection, setSelection] = useState(null);
  const [markers, setMarkers] = useState([]);
  useEffect(() => {
    migrateAnnotationDraft(threadId, item.id);
  }, [threadId, item.id]);
  useEffect(() => {
    const doc = content.current?.ownerDocument;
    if (!doc) return;
    const selectText = () => {
      const selected = window.getSelection();
      if (!selected?.rangeCount || selected.isCollapsed) {
        setSelection(null);
        return;
      }
      const range = selected.getRangeAt(0);
      if (
        !content.current.contains(range.startContainer) ||
        !content.current.contains(range.endContainer) ||
        !selected.toString().trim()
      ) {
        setSelection(null);
        return;
      }
      const text = selected.toString();
      const anchorText = range.toString();
      const before = range.cloneRange();
      before.selectNodeContents(content.current);
      before.setEnd(range.startContainer, range.startOffset);
      const startOffset = before.toString().length;
      const rect = range.getBoundingClientRect();
      const scale = viewportScale();
      setSelection({
        text,
        range,
        anchorText,
        source: {
          messageId: item.id,
          startOffset,
          endOffset: startOffset + anchorText.length,
        },
        anchor: {
          left:
            Math.max(8, Math.min(rect.left, window.innerWidth - 160 * scale)) /
            scale,
          top:
            Math.max(
              8,
              Math.min(rect.bottom + 8, window.innerHeight - 44 * scale),
            ) / scale,
        },
      });
    };
    doc.addEventListener("selectionchange", selectText);
    doc.addEventListener("scroll", selectText, true);
    return () => {
      doc.removeEventListener("selectionchange", selectText);
      doc.removeEventListener("scroll", selectText, true);
    };
  }, [threadId, item.id]);
  useEffect(() => {
    const root = content.current;
    if (!root?.ownerDocument?.createTreeWalker) return;
    if (!entries.some((entry) => entry.source?.messageId === item.id)) {
      setMarkers([]);
      return;
    }
    const position = () => {
      const scale = viewportScale();
      const container = root.closest(".conversation")?.getBoundingClientRect();
      const boundary =
        document.querySelector(".composer-wrap")?.getBoundingClientRect().top ??
        window.innerHeight;
      setMarkers(
        entries.flatMap((entry, index) => {
          if (entry.source?.messageId !== item.id) return [];
          const range = sourceRange(root, entry);
          const rect = range?.getClientRects()[0];
          if (
            !rect ||
            rect.bottom < (container?.top ?? 0) ||
            rect.top > boundary
          )
            return [];
          return [
            {
              entry,
              index,
              left:
                Math.max(12, Math.min(rect.right, window.innerWidth - 16)) /
                scale,
              top: Math.max(8, rect.top - 10) / scale,
            },
          ];
        }),
      );
    };
    position();
    document.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    const observer = new ResizeObserver(position);
    observer.observe(root);
    return () => {
      document.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
      observer.disconnect();
    };
  }, [entries, item.id, item.text]);
  return (
    <>
      <div ref={content} data-annotation-message={item.id}>
        {children}
      </div>
      {selection &&
        createPortal(
          <button
            type="button"
            className="annotation-add"
            style={selection.anchor}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              const markdown = markdownFromRange(
                selection.range,
                content.current.querySelector?.("[data-markdown-selection]"),
              );
              const text = markdown || selection.text;
              const entry = {
                id: uid(),
                text,
                ...(text !== selection.anchorText && {
                  anchorText: selection.anchorText,
                }),
                source: selection.source,
                annotation: "",
              };
              writeAnnotationDrafts(threadId, [
                ...readAnnotationDrafts(threadId),
                entry,
              ]);
              set({
                annotationEditor: {
                  threadId,
                  id: entry.id,
                  point: selection.anchor,
                },
              });
              setSelection(null);
              window.getSelection()?.removeAllRanges?.();
            }}
          >
            <MessageSquare size={14} />
            注释选中文字
          </button>,
          document.body,
        )}
      {markers.map(({ entry, index, left, top }) =>
        createPortal(
          <button
            key={entry.id}
            type="button"
            className="annotation-draft-marker"
            style={{ left, top }}
            aria-label={`编辑批注 ${index + 1}`}
            title={entry.annotation || entry.text}
            onClick={() =>
              set({ annotationEditor: { threadId, id: entry.id } })
            }
          >
            {index + 1}
          </button>,
          document.body,
        ),
      )}
    </>
  );
}

export function ComposerAnnotations({ onSubmit }) {
  const s = useStore();
  const threadId = s.current?.id;
  const entries = useAnnotationDrafts(threadId);
  const editor =
    s.annotationEditor?.threadId === threadId ? s.annotationEditor : null;
  const entry = entries.find((entry) => entry.id === editor?.id);
  const remove = (id) => {
    writeAnnotationDrafts(
      threadId,
      entries.filter((entry) => entry.id !== id),
    );
    if (editor?.id === id) set({ annotationEditor: null });
  };
  if (!entries.length) return null;
  return (
    <>
      <div
        className="annotation-attachments"
        aria-label={`待发送批注（${entries.length}）`}
      >
        {entries.map((entry, index) => (
          <div className="annotation-attachment" key={entry.id}>
            <button
              type="button"
              title={entry.annotation || entry.text}
              aria-label={`打开批注 ${index + 1}`}
              onClick={() => {
                annotationRoot(entry.source?.messageId)?.scrollIntoView({
                  block: "nearest",
                });
                set({ annotationEditor: { threadId, id: entry.id } });
              }}
            >
              <MessageSquare size={13} />
              <span>
                {index + 1}. {entry.annotation || entry.text}
              </span>
            </button>
            <button
              type="button"
              aria-label={`移除批注 ${index + 1}`}
              onClick={() => remove(entry.id)}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
      {entry && (
        <AnnotationEditor
          key={`${threadId}-${entry.id}`}
          annotationRoot={annotationRoot}
          sourceRange={sourceRange}
          viewportScale={viewportScale}
          entry={entry}
          editor={editor}
          onSubmit={onSubmit}
          onRemove={() => remove(entry.id)}
        />
      )}
    </>
  );
}

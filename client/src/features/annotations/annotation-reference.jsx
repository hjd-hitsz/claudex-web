import React, { createContext, useContext, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { MessageSquare } from "lucide-react";
import { useDismissibleMenu } from "../../ui/dismissible-menu.js";

export const AnnotationContext = createContext([]);

export function AnnotationReference({ index, renderQuote }) {
  const annotation = useContext(AnnotationContext)[Number(index) - 1];
  const { open, triggerProps, menuProps, scopeProps } = useDismissibleMenu();
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerProps.ref.current;
    const note = menuProps.ref.current;
    if (!trigger?.ownerDocument.defaultView || !note) return;
    const position = () => {
      const anchor = trigger.getBoundingClientRect();
      const bounds = note.getBoundingClientRect();
      const left = Math.max(
        8,
        Math.min(anchor.left, window.innerWidth - bounds.width - 8),
      );
      const top =
        anchor.bottom + bounds.height + 8 <= window.innerHeight
          ? anchor.bottom + 4
          : Math.max(8, anchor.top - bounds.height - 4);
      note.style.left = left + "px";
      note.style.top = top + "px";
    };
    position();
    note.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(note);
    document.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      document.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [open]);

  return (
    <span className="annotation-reference" {...scopeProps}>
      <button type="button" className="annotation-marker" {...triggerProps}>
        <MessageSquare size={12} />
        注释 {index}
      </button>
      {open &&
        createPortal(
          <div
            role="note"
            className="annotation-note"
            tabIndex={-1}
            {...menuProps}
          >
            {annotation ? (
              <>
                <strong>选中的原文</strong>
                {renderQuote(annotation, triggerProps.ref)}
                {annotation.annotation && (
                  <>
                    <strong>你的注释</strong>
                    <span>{annotation.annotation}</span>
                  </>
                )}
              </>
            ) : (
              <span>暂时无法显示这条批注。</span>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}

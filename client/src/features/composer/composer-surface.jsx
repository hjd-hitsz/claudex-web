import React, { useEffect, useLayoutEffect, useState } from "react";
import { X } from "lucide-react";
import { IconButton } from "../../ui/primitives.jsx";
import { useSurfaceResize } from "../../ui/surface-resize.jsx";
import {
  captureComposerPreview,
  ComposerPlaceholder,
} from "./composer-placeholder.jsx";

export function ComposerSurface({ expanded, onClose, children }) {
  const surface = useSurfaceResize({ id: "message-editor", active: expanded });
  const [snapshot, setSnapshot] = useState(null);
  useLayoutEffect(() => {
    const node = surface.ref.current;
    if (!node?.showModal) return;
    if (expanded && !node.open) {
      const focused = document.activeElement;
      node.showModal();
      focused?.focus({ preventScroll: true });
    } else if (!expanded && node.open) {
      node.close();
      setSnapshot(null);
    }
  }, [expanded]);
  useEffect(() => {
    const node = surface.ref.current;
    return () => {
      if (node?.open) node.close();
    };
  }, []);
  return (
    <>
      <dialog
        ref={surface.ref}
        className="composer-wrap composer-surface"
        role={expanded ? "dialog" : "region"}
        aria-label={expanded ? "编辑消息" : "消息输入"}
        aria-modal={expanded || undefined}
        style={expanded ? surface.style : undefined}
        onClickCapture={(event) => {
          if (!expanded && event.target.closest("[data-composer-expand]"))
            setSnapshot(captureComposerPreview(event.currentTarget));
        }}
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
        onKeyDownCapture={(event) => {
          if (
            expanded &&
            event.key === "Escape" &&
            !event.currentTarget.querySelector(
              '.shortcut-popover, .language-button[data-expanded="true"]',
            )
          ) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        onClick={(event) => {
          if (!expanded || event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }}
      >
        {expanded && (
          <div className="composer-focus-header">
            <strong>编辑消息</strong>
            <IconButton icon={X} title="关闭编辑窗口" onClick={onClose} />
          </div>
        )}
        {children}
        {expanded && surface.handle}
      </dialog>
      {expanded && snapshot && <ComposerPlaceholder snapshot={snapshot} />}
    </>
  );
}

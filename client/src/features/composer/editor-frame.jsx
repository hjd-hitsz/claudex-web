import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ResizeHandle } from "../../ui/resize-handle.jsx";
import { saved } from "../../infrastructure/storage.js";

export function EditorFrame({
  children,
  value,
  ready,
  expanded,
  onExpandedChange,
}) {
  const root = useRef(null);
  const drag = useRef(null);
  const measure = useRef(() => {});
  const [ratio, setRatio] = useState(() => {
    const stored = saved("cx-composer-height", null);
    return Number.isFinite(stored) && stored > 0 && stored <= 1 ? stored : null;
  });
  const [bounds, setBounds] = useState(null);

  function finish(event) {
    const current = drag.current;
    if (event?.pointerId !== undefined && current?.id !== event.pointerId)
      return;
    drag.current = null;
    if (current?.handle.hasPointerCapture(current.id))
      current.handle.releasePointerCapture(current.id);
  }

  function change(height) {
    onExpandedChange(false);
    const next =
      Math.max(bounds.min, Math.min(bounds.max, height)) / bounds.available;
    setRatio(next);
    try {
      localStorage.setItem("cx-composer-height", JSON.stringify(next));
    } catch {
      // 浏览器存储不可用时，本页面继续保留高度选择。
    }
  }

  function reset() {
    finish();
    setRatio(null);
    onExpandedChange(false);
    try {
      localStorage.removeItem("cx-composer-height");
    } catch {
      // 浏览器存储不可用时，仍恢复本页面的自动高度。
    }
  }

  useLayoutEffect(() => {
    const node = root.current;
    if (!node?.ownerDocument?.defaultView) return;
    const viewport = node.querySelector(
      ".document-editor-viewport:not([hidden]), textarea",
    );
    const content = node.querySelector(".milkdown");
    const layout = node.closest(".conversation-layout");
    let frame;
    const update = () => {
      const css = getComputedStyle(node);
      const available = layout?.clientHeight || innerHeight;
      const chrome =
        node.closest(".composer").offsetHeight - viewport.offsetHeight;
      const max = Math.max(
        24,
        Math.min(available * 0.72, available - chrome - 80),
      );
      const min = Math.min(parseFloat(css.lineHeight) * 2, max);
      node.style.setProperty("--document-limit", `${max}px`);
      let natural = content?.offsetHeight;
      if (!content) {
        viewport.style.height = "0px";
        natural = viewport.scrollHeight;
        viewport.style.height = "";
      }
      const desired = expanded
        ? max
        : ratio
          ? ratio * available
          : Math.min(natural, available * 0.4, 360);
      const height = Math.max(min, Math.min(max, desired));
      node.style.setProperty("--document-height", `${height}px`);
      const next = { min, max, height, available };
      setBounds((previous) =>
        previous &&
        Object.keys(next).every((key) => previous[key] === next[key])
          ? previous
          : next,
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    measure.current = schedule;
    const observer = new ResizeObserver(schedule);
    observer.observe(layout || node.parentElement);
    observer.observe(node.closest(".composer"));
    if (content) observer.observe(content);
    window.addEventListener("blur", finish);
    window.addEventListener("resize", finish);
    update();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("blur", finish);
      window.removeEventListener("resize", finish);
    };
  }, [ready, ratio, expanded]);

  useEffect(() => () => finish(), []);

  useLayoutEffect(() => measure.current(), [value]);

  return (
    <div
      ref={root}
      className="markdown-composer"
      data-expanded={expanded || undefined}
    >
      <ResizeHandle
        direction="y"
        className="composer-resizer"
        role="separator"
        tabIndex={0}
        aria-label="调整消息输入框高度"
        aria-orientation="horizontal"
        aria-valuemin={bounds?.min}
        aria-valuemax={bounds?.max}
        aria-valuenow={bounds?.height}
        title="向上拖动增高，方向键调整，双击或 Home 恢复自动高度"
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            id: event.pointerId,
            handle: event.currentTarget,
            y: event.clientY,
            height: bounds.height,
          };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start?.id === event.pointerId)
            change(start.height + start.y - event.clientY);
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onDoubleClick={reset}
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Home") reset();
          else
            change(
              bounds.height +
                (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 64 : 16),
            );
        }}
      />
      {children}
    </div>
  );
}

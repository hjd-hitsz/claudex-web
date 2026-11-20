import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { persist, saved } from "../../infrastructure/storage.js";

export function useTerminalResize({
  direction,
  storageKey,
  dragClass,
  measure,
  extraTarget,
  tolerance = 0,
}) {
  const container = useRef();
  const guide = useRef();
  const drag = useRef();
  const [layout, setLayout] = useState(null);
  const [ratio, setRatio] = useState(() => {
    const value = saved(storageKey, null);
    return Number.isFinite(value) && value > 0 ? value : null;
  });
  const vertical = direction === "y";
  const coordinate = vertical ? "clientY" : "clientX";
  const readLayout = () => measure(container.current, guide.current);

  function changeSize(size) {
    const { min, max, base } = readLayout();
    setRatio(Math.max(min, Math.min(max, size)) / base);
  }

  function finish(event) {
    const current = drag.current;
    if (
      event?.pointerId !== undefined &&
      current?.pointerId !== event.pointerId
    )
      return;
    drag.current = null;
    document.body.classList.remove(dragClass);
    if (current?.element.hasPointerCapture(current.pointerId))
      current.element.releasePointerCapture(current.pointerId);
  }

  useEffect(() => {
    try {
      if (ratio === null) localStorage.removeItem(storageKey);
      else persist(storageKey, ratio);
    } catch {
      // 浏览器存储不可用时，当前页面仍保留尺寸选择。
    }
  }, [ratio, storageKey]);

  useLayoutEffect(() => {
    let previous;
    const update = () => {
      const next = readLayout();
      if (
        previous &&
        ["base", "min", "max"].some((key) =>
          tolerance
            ? Math.abs(next[key] - previous[key]) > tolerance
            : next[key] !== previous[key],
        )
      )
        finish();
      previous = next;
      setLayout((old) =>
        old && Object.keys(next).every((key) => old[key] === next[key])
          ? old
          : next,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(container.current);
    observer.observe(container.current.parentElement);
    observer.observe(guide.current);
    const extra = extraTarget?.(container.current);
    if (extra) observer.observe(extra);
    update();
    window.addEventListener("blur", finish);
    return () => {
      observer.disconnect();
      window.removeEventListener("blur", finish);
      finish();
    };
  }, []);

  const handle = {
    direction,
    role: "separator",
    tabIndex: 0,
    "aria-orientation": vertical ? "horizontal" : "vertical",
    "aria-valuemin": layout?.min,
    "aria-valuemax": layout?.max,
    "aria-valuenow": layout?.size,
    onPointerDown(event) {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        element: event.currentTarget,
        pointerId: event.pointerId,
        coordinate: event[coordinate],
        size: readLayout().size,
      };
      document.body.classList.add(dragClass);
    },
    onPointerMove(event) {
      const current = drag.current;
      if (current?.pointerId === event.pointerId)
        changeSize(current.size + current.coordinate - event[coordinate]);
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
    onDoubleClick: () => setRatio(null),
    onKeyDown(event) {
      const { size, step, min, max } = readLayout();
      const next = {
        [vertical ? "ArrowUp" : "ArrowLeft"]: size + step,
        [vertical ? "ArrowDown" : "ArrowRight"]: size - step,
        Home: min,
        End: max,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      changeSize(next);
    },
  };

  return { container, guide, layout, ratio, handle };
}

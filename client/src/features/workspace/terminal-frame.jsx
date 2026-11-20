import React from "react";
import { ResizeHandle } from "../../ui/resize-handle.jsx";
import { useTerminalResize } from "./terminal-resize.js";

const footer = (panel) =>
  panel.parentElement.querySelector(".conversation-footer");

function measureHeight(panel, guide) {
  const workspace = panel.parentElement.querySelector(".workspace");
  const baseline = guide.getBoundingClientRect();
  const size = panel.getBoundingClientRect().height;
  const base = size + (workspace?.getBoundingClientRect().height || 0);
  const reserve = Math.max(
    baseline.height,
    footer(panel)?.getBoundingClientRect().height || 0,
  );
  return {
    size,
    base,
    min: baseline.width,
    max: Math.max(baseline.width, base - reserve),
    step: parseFloat(getComputedStyle(panel).fontSize),
  };
}

export function TerminalFrame({ children }) {
  const { container, guide, ratio, layout, handle } = useTerminalResize({
    direction: "y",
    storageKey: "cx-terminal-height",
    dragClass: "terminal-height-resizing",
    measure: measureHeight,
    extraTarget: footer,
    tolerance: 0.5,
  });
  return (
    <div
      className="terminal-panel"
      ref={container}
      style={{
        "--terminal-height-max": layout ? layout.max + "px" : undefined,
        "--terminal-preferred-height":
          ratio !== null && layout ? ratio * layout.base + "px" : undefined,
      }}
    >
      <span ref={guide} className="terminal-height-guide" aria-hidden="true" />
      <ResizeHandle
        {...handle}
        className="terminal-height-resizer"
        aria-label="调整终端面板高度"
        title="拖动调整终端高度，双击恢复默认"
      />
      {children}
    </div>
  );
}

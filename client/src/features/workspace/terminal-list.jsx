import React from "react";
import { Trash2 } from "lucide-react";
import { IconButton } from "../../ui/primitives.jsx";
import { ResizeHandle } from "../../ui/resize-handle.jsx";
import { TerminalProcessIcon, processLabel } from "./terminal-process-icon.jsx";
import { useTerminalResize } from "./terminal-resize.js";

function measureWidth(container, guide) {
  const style = getComputedStyle(container);
  const baseline = guide.getBoundingClientRect();
  return {
    size: container.getBoundingClientRect().width,
    base: baseline.width,
    min: baseline.height,
    max:
      container.parentElement.clientWidth *
      parseFloat(style.getPropertyValue("--terminal-list-limit")),
    step: parseFloat(style.fontSize),
  };
}

export function TerminalList({ ids, terminals, active, select, terminate }) {
  const { container, guide, ratio, handle } = useTerminalResize({
    direction: "x",
    storageKey: "cx-terminal-list-width",
    dragClass: "terminal-list-resizing",
    measure: measureWidth,
  });
  return (
    <div
      className="terminal-list-container"
      ref={container}
      style={{ "--terminal-list-scale": ratio ?? 1 }}
    >
      <span
        className="terminal-list-width-guide"
        ref={guide}
        aria-hidden="true"
      />
      <ResizeHandle
        {...handle}
        className="terminal-list-resizer"
        aria-label="调整终端列表宽度"
        title="拖动调整终端列表宽度，双击恢复默认"
      />
      <div className="terminal-list" aria-label="终端列表">
        {ids.map((id, index) => (
          <div className="terminal-row" key={id} data-active={id === active}>
            <button
              className="terminal-tab"
              aria-label={processLabel(terminals[id]?.processName)}
              title={processLabel(terminals[id]?.processName)}
              aria-pressed={id === active}
              onClick={() => select(id)}
            >
              <TerminalProcessIcon name={terminals[id]?.processName} />
              <span className="terminal-name">
                {processLabel(terminals[id]?.processName)}
              </span>
            </button>
            <IconButton
              icon={Trash2}
              title={`结束 ${processLabel(terminals[id]?.processName)}`}
              aria-label={`结束终端 ${index + 1}`}
              onClick={() => terminate(id)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

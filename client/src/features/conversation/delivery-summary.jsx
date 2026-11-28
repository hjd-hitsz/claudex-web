import React, { useId } from "react";
import {
  ChevronRight,
  ClipboardList,
  Mail,
  TerminalSquare,
} from "lucide-react";

const sources = {
  background: { label: "后台终端", Icon: TerminalSquare },
  delegation: { label: "委派结果", Icon: ClipboardList },
  peer: { label: "会话来信", Icon: Mail },
};

export function DeliverySummary({
  source,
  title,
  status,
  preview,
  action,
  onOpen,
  expanded,
  controls,
}) {
  const { label, Icon } = sources[source];
  const statusText = status.join(" · ");
  const Element = onOpen ? "button" : "div";
  const previewId = useId();
  return (
    <Element
      className="delivery-summary"
      aria-label={[
        label,
        title !== label && title,
        statusText,
        onOpen && action,
      ]
        .filter(Boolean)
        .join("，")}
      aria-describedby={preview ? previewId : undefined}
      {...(onOpen
        ? {
            type: "button",
            onClick: onOpen,
            "aria-expanded": expanded,
            "aria-controls": controls,
          }
        : { role: "group" })}
    >
      <span className="delivery-summary-content">
        <span className="delivery-summary-source">
          <Icon size={13} aria-hidden="true" />
          {label}
        </span>
        <span className="delivery-summary-title">{title}</span>
        <span className="delivery-summary-status">
          {status.map((part, index) => (
            <React.Fragment key={part}>
              <span className="delivery-summary-status-part">
                {part}
                {index < status.length - 1 ? "\u00a0·" : ""}
              </span>
              {index < status.length - 1 ? " " : ""}
            </React.Fragment>
          ))}
        </span>
        {preview && (
          <span id={previewId} className="delivery-summary-preview">
            {preview}
          </span>
        )}
      </span>
      {onOpen && (
        <ChevronRight
          className="delivery-summary-arrow"
          size={15}
          aria-hidden="true"
        />
      )}
    </Element>
  );
}

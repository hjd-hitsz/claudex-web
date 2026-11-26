import React, { useId } from "react";
import { ChevronRight } from "lucide-react";

export function DeliverySummary({ title, status, preview, action, onOpen }) {
  const Element = onOpen ? "button" : "div";
  const previewId = useId();
  return (
    <Element
      className="delivery-summary"
      {...(onOpen && {
        type: "button",
        onClick: onOpen,
        "aria-label": `${title}，${status}，${action}`,
        "aria-describedby": preview ? previewId : undefined,
      })}
    >
      <span className="delivery-summary-title">{title}</span>
      <span className="delivery-summary-status">{status}</span>
      {preview && (
        <span id={previewId} className="delivery-summary-preview">
          {preview}
        </span>
      )}
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

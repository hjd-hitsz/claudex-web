import React, { useState } from "react";
import { MessageSquare } from "lucide-react";
import { AnnotationQuote } from "../markdown/rich-text.jsx";

function AnnotationCard({ entry, index, cwd }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="annotation-card"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <MessageSquare size={14} />
        <span>注释 {index + 1}</span>
        <span className="annotation-card-label">
          {entry.annotation || entry.text}
        </span>
      </summary>
      {open && (
        <blockquote className="annotation-quote">
          <AnnotationQuote entry={entry} cwd={cwd} />
        </blockquote>
      )}
    </details>
  );
}

export function UserAnnotations({ annotations, cwd }) {
  return annotations.map((entry, index) => (
    <AnnotationCard key={index} entry={entry} index={index} cwd={cwd} />
  ));
}

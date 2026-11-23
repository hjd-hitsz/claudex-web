import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Files, X } from "lucide-react";
import { basename } from "../../domain/format.js";
import { pathIcon } from "../../ui/path-icon.jsx";

function CodeLocation({ matches, code }) {
  const id = useId();
  const preview = useRef();
  const [anchor, setAnchor] = useState(null);
  const [{ path, line }] = matches;
  const extra = matches.length - 1;
  const Icon = extra ? Files : pathIcon(path, { literal: true });
  const lines = code.split("\n");
  const location = (start) =>
    lines.length === 1 ? start : `${start}–${start + lines.length - 1}`;
  function show({ currentTarget }) {
    const rect = currentTarget.getBoundingClientRect();
    setAnchor({
      left: rect.left,
      top: rect.top,
      bottom: rect.bottom,
      root: currentTarget.closest("dialog[open]") ?? document.body,
    });
  }
  function hide() {
    setAnchor(null);
  }
  useLayoutEffect(() => {
    if (!anchor || !preview.current) return;
    const { width, height } = preview.current.getBoundingClientRect();
    const top = anchor.top - height - 5;
    preview.current.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - width - 8))}px`;
    preview.current.style.top = `${Math.max(8, top >= 8 ? top : Math.min(anchor.bottom + 5, innerHeight - height - 8))}px`;
  }, [anchor]);
  useEffect(() => {
    if (!anchor) return;
    window.addEventListener("resize", hide);
    document.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("resize", hide);
      document.removeEventListener("scroll", hide, true);
    };
  }, [anchor]);
  return (
    <>
      <button
        type="button"
        className="code-location"
        aria-describedby={anchor ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={show}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !anchor) return;
          event.preventDefault();
          hide();
          event.stopPropagation();
        }}
      >
        <Icon size={13} aria-hidden="true" />
        <span className="code-file-name">{basename(path)}</span>
        <span className="code-file-line">:{location(line)}</span>
        {extra > 0 && (
          <span className="code-file-count" aria-label={`还有 ${extra} 个候选`}>
            +{extra}
          </span>
        )}
      </button>
      {anchor &&
        createPortal(
          <div
            id={id}
            ref={preview}
            role="tooltip"
            className="code-file-preview"
          >
            <div className="code-file-preview-path">
              {matches.map((match) => (
                <div key={match.path}>
                  {match.path}:{location(match.line)}
                </div>
              ))}
            </div>
            <pre>
              {lines.slice(0, 8).map((text, index) => (
                <span className="code-file-preview-line" key={line + index}>
                  {!extra && <span aria-hidden="true">{line + index}</span>}
                  <code>{text}</code>
                </span>
              ))}
            </pre>
          </div>,
          anchor.root,
        )}
    </>
  );
}

export function CodeFileAttachments({ attachments = [], onRemove }) {
  if (!attachments.length) return null;
  return (
    <div
      className="annotation-attachments code-file-attachments"
      aria-label="代码文件候选"
    >
      {attachments.map(({ id, matches, code }) => (
        <div
          className="code-file-attachment"
          data-code-file-attachment={id}
          key={id}
          role="group"
          aria-label="匹配位置"
        >
          <CodeLocation matches={matches} code={code} />
          {onRemove && (
            <button
              className="code-file-remove"
              type="button"
              aria-label="移除代码文件候选"
              onClick={() => onRemove(id)}
            >
              <X size={13} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

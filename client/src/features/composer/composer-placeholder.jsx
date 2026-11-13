import React, { useLayoutEffect, useRef } from "react";

const previewStyles = new WeakMap();

export function captureComposerPreview(node) {
  const styles = [...node.ownerDocument.styleSheets].map((sheet) => {
    let copy = previewStyles.get(sheet);
    if (!copy) {
      copy = new CSSStyleSheet();
      copy.replaceSync(
        [...sheet.cssRules].map((rule) => rule.cssText).join("\n"),
      );
      previewStyles.set(sheet, copy);
    }
    return copy;
  });
  const preview = node.cloneNode(true);
  preview.querySelector(".shortcut-popover")?.remove();
  const selector = ".document-editor-viewport, .cm-scroller";
  const offsets = [...node.querySelectorAll(selector)];
  const scroll = [...preview.querySelectorAll(selector)].map(
    (element, index) => ({
      element,
      top: offsets[index].scrollTop,
      left: offsets[index].scrollLeft,
    }),
  );
  return { node: preview, height: node.offsetHeight, scroll, styles };
}

// 隔离只读预览的元素、样式和标识，保留底部输入区的实际排版。
export function ComposerPlaceholder({ snapshot }) {
  const host = useRef(null);
  useLayoutEffect(() => {
    const shadow = host.current.attachShadow({ mode: "closed" });
    const restoreScroll = () => {
      for (const { element, top, left } of snapshot.scroll) {
        element.scrollTop = top;
        element.scrollLeft = left;
      }
    };
    shadow.adoptedStyleSheets = snapshot.styles;
    shadow.append(snapshot.node);
    const frame = requestAnimationFrame(restoreScroll);
    return () => cancelAnimationFrame(frame);
  }, [snapshot]);
  return (
    <div
      ref={host}
      className="composer-placeholder"
      style={{ height: snapshot.height }}
      inert
      aria-hidden="true"
    />
  );
}

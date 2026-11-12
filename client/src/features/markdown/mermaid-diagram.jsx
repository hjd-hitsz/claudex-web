import React, { useEffect, useLayoutEffect, useRef } from "react";

export function MermaidDiagram({ id, svg, expanded, zoom, onZoom, onReset }) {
  const ref = useRef(null);

  useLayoutEffect(() => {
    const viewport = ref.current;
    const diagram = viewport?.querySelector("svg");
    if (!diagram) return;
    const fit = () => {
      const width = diagram.viewBox.baseVal.width;
      if (!width) return;
      const css = getComputedStyle(viewport);
      const available =
        viewport.clientWidth -
        parseFloat(css.paddingLeft) -
        parseFloat(css.paddingRight);
      diagram.style.width = `${Math.min(width, available) * zoom}px`;
      diagram.style.maxWidth = "none";
    };
    fit();
    if (zoom === 1) viewport.scrollTo(0, 0);
    const observer = new ResizeObserver(fit);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [svg, zoom]);

  useEffect(() => {
    const viewport = ref.current;
    if (!viewport) return;
    const wheel = (event) => {
      if (!event.ctrlKey || !event.deltaY) return;
      event.preventDefault();
      onZoom(event.deltaY < 0 ? 1 : -1);
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, [onZoom]);

  return (
    <div
      id={id}
      ref={ref}
      className={"mermaid-diagram" + (expanded ? " is-expanded" : "")}
      role="region"
      aria-label="Mermaid 图表"
      tabIndex={0}
      onKeyDown={(event) => {
        if (["+", "=", "-", "0"].includes(event.key)) {
          event.preventDefault();
          if (event.key === "0") onReset();
          else onZoom(event.key === "-" ? -1 : 1);
        }
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

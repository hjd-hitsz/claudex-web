import React, { useCallback, useEffect, useId, useState } from "react";
import { Copy, Maximize, Minimize, Minus, Plus } from "lucide-react";
import { IconButton } from "../../ui/primitives.jsx";
import { copy, useStore } from "../../store.js";
import { renderMermaid } from "./mermaid-renderer.js";
import { flowchartDirection, orientFlowchart } from "../../domain/mermaid.js";
import { MermaidDiagram } from "./mermaid-diagram.jsx";

export function MermaidBlock({ source }) {
  const { theme } = useStore();
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [result, setResult] = useState(null);
  const [showSource, setShowSource] = useState(false);
  const [direction, setDirection] = useState("");
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const diagramId = useId();
  const changeZoom = useCallback((step) => {
    setZoom((value) => Math.max(0.5, Math.min(8, value + step * 0.25)));
  }, []);
  const renderedSource = orientFlowchart(source, direction);
  const sourceDirection = flowchartDirection(source);
  const displayedDirection = direction || sourceDirection;
  const diagramTheme =
    theme === "dark" || (theme === "system" && systemDark) ? "dark" : "default";
  const current =
    result?.source === renderedSource && result.theme === diagramTheme
      ? result
      : null;
  const svg =
    current?.svg ||
    (!current &&
    result?.originalSource === source &&
    result.theme === diagramTheme
      ? result.svg
      : null);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // 流式代码稳定后再绘制；旧请求完成时只更新其对应的源码和主题。
    const timer = setTimeout(() => {
      renderMermaid(renderedSource, diagramTheme).then(
        (svg) => {
          if (!cancelled)
            setResult({
              source: renderedSource,
              originalSource: source,
              theme: diagramTheme,
              svg,
            });
        },
        () => {
          if (!cancelled)
            setResult({
              source: renderedSource,
              theme: diagramTheme,
              error: true,
            });
        },
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source, renderedSource, diagramTheme]);

  return (
    <div className="code-block mermaid-block">
      <div className="code-heading">
        <span>Mermaid</span>
        <div className="mermaid-actions">
          {!showSource && (
            <>
              {sourceDirection && (
                <select
                  aria-label="图表方向"
                  value={
                    displayedDirection === "LR" || displayedDirection === "RL"
                      ? "LR"
                      : "TB"
                  }
                  onChange={(event) => {
                    setDirection(event.target.value);
                    setZoom(1);
                  }}
                >
                  <option value="LR">横向</option>
                  <option value="TB">纵向</option>
                </select>
              )}
              <div className="mermaid-zoom" role="group" aria-label="图表缩放">
                <IconButton
                  icon={Minus}
                  title="缩小图表"
                  disabled={zoom === 0.5}
                  onClick={() => changeZoom(-1)}
                />
                <button
                  type="button"
                  title="重置图表缩放"
                  aria-label="重置图表缩放"
                  onClick={() => setZoom(1)}
                >
                  {Math.round(zoom * 100)}%
                </button>
                <IconButton
                  icon={Plus}
                  title="放大图表"
                  disabled={zoom === 8}
                  onClick={() => changeZoom(1)}
                />
              </div>
            </>
          )}
          {svg && (
            <>
              {!showSource && (
                <IconButton
                  icon={expanded ? Minimize : Maximize}
                  title={expanded ? "收起图表" : "展开图表"}
                  aria-expanded={expanded}
                  aria-controls={diagramId}
                  onClick={() => setExpanded(!expanded)}
                />
              )}
              <button
                type="button"
                aria-pressed={showSource}
                onClick={() => setShowSource(!showSource)}
              >
                {showSource ? "查看图表" : "查看源码"}
              </button>
            </>
          )}
          <IconButton
            icon={Copy}
            title="复制图表源码"
            onClick={() => copy(source)}
          />
        </div>
      </div>
      {svg && !showSource ? (
        <MermaidDiagram
          id={diagramId}
          svg={svg}
          expanded={expanded}
          zoom={zoom}
          onZoom={changeZoom}
          onReset={() => setZoom(1)}
        />
      ) : (
        <>
          {!current?.svg && (
            <p className="mermaid-status" role="status">
              {current?.error
                ? "图表暂时无法显示，源码可能尚未完整或存在语法错误。"
                : "正在绘制图表…"}
            </p>
          )}
          <pre>
            <code>{source}</code>
          </pre>
        </>
      )}
    </div>
  );
}

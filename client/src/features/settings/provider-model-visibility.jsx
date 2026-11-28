import React, { useId, useLayoutEffect, useRef } from "react";

export function ProviderModelVisibility({
  models,
  aliases,
  hiddenModels = [],
  disabled,
  onChange,
  catalogueControls,
}) {
  const ids = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  const hasModels = ids.length > 0;
  const shortList = ids.length <= 3;
  const titleId = useId();
  const viewport = useRef(null);
  useLayoutEffect(() => {
    if (shortList) return;
    const area = viewport.current;
    const frame = area.parentElement;
    const grid = area.firstElementChild;
    const options = [...grid.children];
    let firstRowsHeight = 0;
    let lastRowsHeight = 0;
    let endSized = false;
    function updateEdges() {
      frame.toggleAttribute("data-more-above", area.scrollTop > 1);
      frame.toggleAttribute(
        "data-more-below",
        area.scrollHeight - area.clientHeight - area.scrollTop > 1,
      );
    }
    function fitEndRows() {
      if (firstRowsHeight === lastRowsHeight) return;
      const distance = area.scrollHeight - area.clientHeight - area.scrollTop;
      if (!endSized && area.scrollTop > 1 && distance <= 1) {
        endSized = true;
        area.style.maxBlockSize = `${lastRowsHeight}px`;
        area.scrollTop = area.scrollHeight;
        updateEdges();
      } else if (
        endSized &&
        distance > 1 + Math.max(0, firstRowsHeight - lastRowsHeight)
      ) {
        endSized = false;
        area.style.maxBlockSize = `${firstRowsHeight}px`;
        updateEdges();
      }
    }
    function measure() {
      const { top, height } = grid.getBoundingClientRect();
      if (!height) return;
      const starts = [
        ...new Set(
          options.map((item) => item.getBoundingClientRect().top - top),
        ),
      ];
      const rowLimit = Number(
        getComputedStyle(area).getPropertyValue(
          "--provider-model-visible-rows",
        ),
      );
      const canScroll = starts.length > rowLimit;
      firstRowsHeight = canScroll ? starts[rowLimit] : 0;
      lastRowsHeight = canScroll
        ? height - starts[starts.length - rowLimit]
        : 0;
      endSized = endSized && canScroll;
      area.style.maxBlockSize = canScroll
        ? `${endSized ? lastRowsHeight : firstRowsHeight}px`
        : "";
      if (endSized) area.scrollTop = area.scrollHeight;
      updateEdges();
    }
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(grid);
    area.addEventListener("scroll", updateEdges);
    // Keep the viewport steady during scrolling, then fit the last full rows.
    area.addEventListener("scrollend", fitEndRows);
    // A wrapped row can cross the viewport edge between two snap points.
    const intersection = new IntersectionObserver(
      (entries) => {
        for (const {
          target,
          isIntersecting,
          intersectionRect,
          boundingClientRect,
        } of entries)
          target.toggleAttribute(
            "data-partial-row",
            isIntersecting &&
              intersectionRect.height < boundingClientRect.height - 1,
          );
      },
      { root: area, threshold: [0, 0.98, 1] },
    );
    for (const option of options) intersection.observe(option);
    return () => {
      area.removeEventListener("scroll", updateEdges);
      area.removeEventListener("scrollend", fitEndRows);
      intersection.disconnect();
      resize.disconnect();
    };
  }, [aliases, models, shortList]);
  if (!hasModels && !catalogueControls) return null;
  const hidden = new Set(hiddenModels);
  const shown = ids.filter((model) => !hidden.has(model)).length;
  function show(models, checked) {
    for (const model of models) {
      if (checked) hidden.delete(model);
      else hidden.add(model);
    }
    onChange([...hidden]);
  }
  const options = ids.map((model) => (
    <label
      className="backend-checkbox provider-model-option"
      key={model}
      title={model}
    >
      <input
        type="checkbox"
        checked={!hidden.has(model)}
        onChange={(event) => show([model], event.target.checked)}
      />
      <span>{aliases?.[model] || model}</span>
    </label>
  ));
  return (
    <fieldset
      className="provider-model-visibility"
      disabled={disabled}
      aria-labelledby={titleId}
    >
      <div className="provider-model-header">
        <div className="provider-model-selection">
          <h3 id={titleId}>显示的模型</h3>
          {hasModels && (
            <label className="backend-checkbox provider-model-select-all">
              <input
                type="checkbox"
                checked={shown === ids.length}
                ref={(input) => {
                  if (input)
                    input.indeterminate = shown > 0 && shown < ids.length;
                }}
                onChange={(event) => show(ids, event.target.checked)}
              />
              全选
            </label>
          )}
          {shortList && options}
        </div>
        {catalogueControls}
      </div>
      {!shortList && (
        <div className="provider-model-visibility-frame">
          <div ref={viewport} className="provider-model-visibility-scroll">
            <div className="provider-model-visibility-options">{options}</div>
          </div>
        </div>
      )}
    </fieldset>
  );
}

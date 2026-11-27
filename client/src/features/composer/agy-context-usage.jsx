import React, { useId, useRef, useState } from "react";
import { ChevronUp } from "lucide-react";

const tokenFields = [
  ["输入", "inputTokens"],
  ["缓存输入", "cachedInputTokens"],
  ["输出", "outputTokens"],
  ["推理输出", "reasoningOutputTokens"],
  ["本轮总量", "totalTokens"],
];

function turnDate(turn) {
  const time = turn?.startedAt ?? turn?.completedAt;
  return time == null ? undefined : new Date(time * 1000).toLocaleString();
}

export function AgyContextUsage({ token, turns = [] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const trigger = useRef(null);
  const id = useId();
  const used = token.last?.totalTokens;
  const capacity = token.modelContextWindow;
  const recent = turns.toSorted(
    (a, b) =>
      (b.startedAt ?? b.completedAt ?? 0) -
        (a.startedAt ?? a.completedAt ?? 0) ||
      (b.completedAt ?? 0) - (a.completedAt ?? 0),
  );
  const currentId =
    token.turnId ?? recent.find((turn) => turn.status !== "inProgress")?.id;
  const history = recent.filter(
    (turn) => turn.id !== currentId && turn.tokenUsage,
  );
  const selectedTurn = history.find((turn) => turn.id === selected);
  const view = selectedTurn?.tokenUsage || token;
  const rows = tokenFields.filter(([, key]) => view.round?.[key] != null);
  const summary = token.awaitingMeasurement
    ? "整理后用量将在下一轮更新"
    : used != null
      ? `上下文已用 ${used.toLocaleString()} tokens`
      : "查看本轮 Token 用量";

  function close() {
    setOpen(false);
    setSelected("");
  }

  return (
    <div
      className="context-info agy-context-usage"
      title={
        !open && capacity
          ? `模型窗口上限 ${capacity.toLocaleString()} tokens`
          : undefined
      }
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close();
          trigger.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        aria-label="查看 Token 用量明细"
        aria-describedby={`${id}-summary`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span id={`${id}-summary`}>{summary}</span>
        <ChevronUp size={12} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={id}
          className="agy-context-details"
          role="region"
          aria-label="Token 用量明细"
        >
          <div className="agy-context-heading">
            {history.length ? (
              <select
                aria-label="选择用量轮次"
                title={turnDate(selectedTurn)}
                value={view === token ? "" : selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                <option value="">本轮</option>
                {history.map((turn, index) => (
                  <option key={turn.id} value={turn.id} title={turnDate(turn)}>
                    {index === 0 ? "上一轮" : `更早 · ${index + 1} 轮前`}
                  </option>
                ))}
              </select>
            ) : (
              <strong>本轮用量</strong>
            )}
            <span>tokens</span>
          </div>
          {rows.length === 0 && <p>本轮明细未上报</p>}
          <dl>
            {rows.map(([label, key]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{view.round[key].toLocaleString()}</dd>
              </div>
            ))}
            {view.modelContextWindow != null && (
              <div>
                <dt>模型窗口上限</dt>
                <dd>{view.modelContextWindow.toLocaleString()}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useId, useRef, useState } from "react";
import { ChevronUp } from "lucide-react";
import { rpc } from "../../store.js";
import { formatTokenCount } from "../../domain/token-format.js";

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

const hasUsage = (token) =>
  token?.last?.totalTokens != null ||
  Object.keys(token?.round ?? {}).length > 0;

export function ContextUsage({ threadId, activeId, token, turns = [] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState([]);
  const trigger = useRef(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    let current = true;
    rpc("thread/turns/list", {
      threadId,
      sortDirection: "desc",
      limit: 20,
      itemsView: "summary",
    }).then(
      (result) => {
        if (current) setPage(result.data);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [open, threadId, activeId]);

  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  for (const turn of page) byId.set(turn.id, { ...byId.get(turn.id), ...turn });
  const recent = [...byId.values()].sort(
    (a, b) =>
      (a.turnNumber && b.turnNumber ? b.turnNumber - a.turnNumber : 0) ||
      (b.startedAt ?? b.completedAt ?? 0) -
        (a.startedAt ?? a.completedAt ?? 0) ||
      (b.completedAt ?? 0) - (a.completedAt ?? 0),
  );
  const currentId =
    token?.turnId ?? recent.find((turn) => turn.status !== "inProgress")?.id;
  const current = recent.find((turn) => turn.id === currentId);
  const history = recent.filter(
    (turn) => turn.id === currentId || hasUsage(turn.tokenUsage),
  );
  if (!current && token) history.unshift({ id: currentId ?? "" });
  const selectedTurn =
    history.find((turn) => turn.id === selected) ??
    history.find((turn) => turn.id === currentId) ??
    history[0];
  const currentUsage = selectedTurn?.id === currentId;
  const view = currentUsage
    ? { ...selectedTurn?.tokenUsage, ...token }
    : selectedTurn?.tokenUsage;
  const rows = tokenFields.filter(([, key]) => {
    const count = view?.round?.[key];
    return count != null && (key !== "reasoningOutputTokens" || count > 0);
  });
  const used = (token ?? history[0]?.tokenUsage)?.last?.totalTokens;
  const capacity = (token ?? history[0]?.tokenUsage)?.modelContextWindow;
  const summary = token?.awaitingMeasurement
    ? "整理后用量将在下一轮更新"
    : used != null
      ? capacity > 0
        ? `上下文 ${formatTokenCount(used)} / ${formatTokenCount(capacity)}（${Math.round((used / capacity) * 100)}%）`
        : `上下文 ${formatTokenCount(used)}`
      : "查看本轮 Token 用量";

  function close() {
    setOpen(false);
    setSelected("");
    setPage([]);
  }

  return (
    <div
      className="context-info context-usage"
      title={
        !open && capacity
          ? `模型窗口上限 ${formatTokenCount(capacity)} tokens`
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
          className="context-usage-details"
          role="region"
          aria-label="Token 用量明细"
        >
          <div className="context-usage-heading">
            {history.length ? (
              <select
                aria-label="选择用量轮次"
                title={turnDate(selectedTurn)}
                value={selectedTurn.id}
                onChange={(event) => setSelected(event.target.value)}
              >
                {history.map((turn) => (
                  <option key={turn.id} value={turn.id} title={turnDate(turn)}>
                    {turn.turnNumber &&
                    (hasUsage(turn.tokenUsage) ||
                      (turn.id === currentId && hasUsage(token)))
                      ? `#${turn.turnNumber}`
                      : "本轮"}
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
                <dd>{formatTokenCount(view.round[key])}</dd>
              </div>
            ))}
            {view?.modelContextWindow != null && (
              <div>
                <dt>模型窗口上限</dt>
                <dd>{formatTokenCount(view.modelContextWindow)}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

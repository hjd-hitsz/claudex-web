import { saved, persist } from "../../infrastructure/storage.js";
import React, { useEffect, useRef, useState } from "react";
import * as store from "../../store.js";
import { MarkdownEditor } from "../composer/markdown-editor.jsx";
import { Undo2, ChevronRight } from "lucide-react";
import { isCompacting } from "../../domain/compaction.js";

export function GoalEditor() {
  const s = store.useStore(),
    id = s.current?.id;
  const goal = s.goals[id];
  const [draft, edit] = useState(
      () => saved("cx-goal-edit-" + id, null)?.draft ?? null,
    ),
    [budget, setBudget] = useState(
      () => saved("cx-goal-edit-" + id, null)?.budget ?? null,
    );
  const [error, setError] = useState("");
  const saving = useRef(false);
  const inputRef = useRef();
  const latest = useRef();
  useEffect(() => {
    store.refreshGoal(id);
  }, [id]);
  useEffect(() => {
    persist("cx-goal-edit-" + id, { draft, budget });
  }, [id, draft, budget]);
  const text = draft ?? goal?.objective ?? "";
  const budgetText = budget ?? goal?.tokenBudget ?? "";
  latest.current = { text, budgetText };
  const updatedMinutes = goal?.updatedAt
    ? Math.max(0, Math.floor((Date.now() / 1000 - goal.updatedAt) / 60))
    : null;
  const dirty =
    text !== (goal?.objective ?? "") ||
    String(budgetText) !== String(goal?.tokenBudget ?? "");
  const disabled =
    !s.connected || s.busy || s.goalBusy[id] || isCompacting(s.compactions[id]);
  async function save() {
    if (disabled || saving.current || !dirty || !text.trim()) return;
    const tokenBudget = budgetText === "" ? null : Number(budgetText);
    if (
      tokenBudget !== null &&
      (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
    ) {
      setError("Token 预算须为正整数。");
      return;
    }
    saving.current = true;
    setError("");
    try {
      if (
        await store.updateGoal(id, {
          objective: text.trim(),
          status: "active",
          tokenBudget,
        })
      ) {
        if (
          latest.current.text === text &&
          latest.current.budgetText === budgetText
        ) {
          edit(null);
          setBudget(null);
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      saving.current = false;
    }
  }
  return (
    <section className="context-panel goal-editor" aria-label="编辑目标">
      <div className="goal-editor-actions">
        <span>
          {updatedMinutes === null
            ? "尚未保存"
            : updatedMinutes === 0
              ? "刚刚更新"
              : `${updatedMinutes} 分钟前更新`}
        </span>
        <button
          className="icon-button"
          aria-label="还原"
          title="还原"
          disabled={!dirty || disabled}
          onClick={() => {
            edit(null);
            setBudget(null);
          }}
        >
          <Undo2 size={15} />
        </button>
        <button
          className="primary"
          disabled={!dirty || !text.trim() || disabled}
          onClick={save}
        >
          {s.goalBusy[id] ? "正在保存…" : "保存"}
        </button>
      </div>
      {(error || s.goalErrors[id]) && (
        <div className="inline-error" role="alert">
          {error || s.goalErrors[id]}
          <button onClick={() => store.refreshGoal(id)}>重试读取</button>
        </div>
      )}
      <div className="goal-editor-input">
        <MarkdownEditor
          fill
          inputRef={inputRef}
          aria-label="目标"
          theme={s.theme}
          rows={8}
          value={text}
          onChange={(e) => edit(e.target.value)}
          placeholder="描述目标和可衡量的完成条件…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.ctrlKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              save();
            }
          }}
        />
      </div>
      <footer className="goal-editor-footer">
        <details className="goal-editor-budget">
          <summary>
            <ChevronRight size={13} />
            <span>Token 预算</span>
            <span className="goal-budget-value">
              {budgetText === "" ? "不限" : Number(budgetText).toLocaleString()}
            </span>
          </summary>
          <label className="field-label">
            <input
              placeholder="不限"
              aria-label="Token 预算"
              type="number"
              min="1"
              step="1"
              value={budgetText}
              disabled={disabled}
              onChange={(e) => setBudget(e.target.value)}
            />
          </label>
        </details>
        {goal && (
          <small>
            已用 {(goal.tokensUsed ?? 0).toLocaleString()} tokens ·{" "}
            {Math.round(goal.timeUsedSeconds ?? 0)} 秒
          </small>
        )}
      </footer>
      {goal?.error && (
        <p role="alert" className="inline-error">
          {goal.error.message}
        </p>
      )}
    </section>
  );
}

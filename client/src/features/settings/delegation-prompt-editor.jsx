import React, { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { rpc } from "../../store.js";

export function DelegationPromptSelect({ label, value, prompts, onChange }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">默认提示词</option>
      {prompts.map(({ id, name }) => (
        <option key={id} value={id}>
          {name || "未命名提示词"}
        </option>
      ))}
    </select>
  );
}

export function DelegationPromptEditor({
  active,
  selected,
  select,
  prompts,
  add,
  update,
  remove,
}) {
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState("");
  const [loadingError, setLoadingError] = useState("");
  const [feedback, setFeedback] = useState(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active || saved) return;
    let current = true;
    setLoadingError("");
    rpc("lan/backends/agy/role/read").then(
      (role) => {
        if (!current) return;
        setSaved(role);
        setDraft(role.content);
      },
      (error) => {
        if (current) setLoadingError(error.message);
      },
    );
    return () => {
      current = false;
    };
  }, [active, attempt, saved]);

  function changeDefault(content) {
    setDraft(content);
    setFeedback(null);
  }

  async function saveDefault() {
    if (!draft.trim() || draft === saved.content || saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      const role = await rpc("lan/backends/agy/role/save", { content: draft });
      setSaved(role);
      setDraft(role.content);
      setFeedback({
        message: role.customized ? "默认提示词已保存" : "已恢复内置提示词",
      });
    } catch (error) {
      setFeedback({ error: true, message: error.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="delegation-prompts"
      aria-labelledby="delegation-prompts-title"
    >
      <h3 id="delegation-prompts-title">提示词预设</h3>
      <div className="delegation-prompt-actions">
        <DelegationPromptSelect
          label="选择要编辑的提示词"
          value={selected?.id || ""}
          prompts={prompts}
          onChange={select}
        />
        <button
          type="button"
          className="secondary"
          disabled={!saved || saving || prompts.length >= 100}
          onClick={() => add(saved.content)}
        >
          <Plus size={15} aria-hidden="true" /> 新增
        </button>
      </div>
      {selected ? (
        <div className="delegation-prompt-editor">
          <label>
            名称
            <input
              type="text"
              maxLength={80}
              value={selected.name}
              onChange={(event) => update({ name: event.target.value })}
              required
            />
          </label>
          <label>
            提示词正文
            <textarea
              aria-label="提示词正文"
              rows={5}
              value={selected.content}
              onChange={(event) => update({ content: event.target.value })}
              required
            />
          </label>
          <div className="delegation-prompt-buttons">
            <button type="button" className="secondary" onClick={remove}>
              删除提示词
            </button>
          </div>
        </div>
      ) : (
        <section className="delegation-prompt-editor" aria-label="默认提示词">
          {saved ? (
            <>
              <label>
                默认提示词正文
                <textarea
                  aria-label="默认提示词正文"
                  rows={5}
                  spellCheck={false}
                  readOnly={saving}
                  value={draft}
                  onChange={(event) => changeDefault(event.target.value)}
                />
              </label>
              <div className="delegation-prompt-buttons">
                <button
                  type="button"
                  className="secondary"
                  disabled={saving || draft === saved.defaultContent}
                  onClick={() => changeDefault(saved.defaultContent)}
                >
                  载入内置模板
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={saving || !draft.trim() || draft === saved.content}
                  onClick={saveDefault}
                >
                  {saving ? "正在保存…" : "保存默认提示词"}
                </button>
              </div>
              {feedback && (
                <span role={feedback.error ? "alert" : "status"}>
                  {feedback.message}
                </span>
              )}
            </>
          ) : loadingError ? (
            <div className="delegation-prompt-buttons">
              <span role="alert">{loadingError}</span>
              <button
                type="button"
                className="secondary"
                onClick={() => setAttempt((value) => value + 1)}
              >
                重新加载
              </button>
            </div>
          ) : (
            <span role="status">正在读取默认提示词…</span>
          )}
        </section>
      )}
    </section>
  );
}

import React, { useEffect, useId, useState } from "react";
import { rpc } from "../../store.js";

export function AgyRoleSettings({ active }) {
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [retry, setRetry] = useState(0);
  const heading = useId();
  const loaded = saved !== null;
  const modified =
    saved &&
    (draft !== saved.content ||
      (saved.customized && draft === saved.defaultContent));

  useEffect(() => {
    if (!active || loaded) return;
    let current = true;
    setFeedback(null);
    rpc("lan/backends/agy/role/read").then(
      (role) => {
        if (!current) return;
        setSaved(role);
        setDraft(role.content);
      },
      (error) => {
        if (current) setFeedback({ error: true, message: error.message });
      },
    );
    return () => {
      current = false;
    };
  }, [active, loaded, retry]);

  async function save(event) {
    event.preventDefault();
    if (saving || !modified || !draft.trim()) return;
    setSaving(true);
    setFeedback(null);
    try {
      const role = await rpc("lan/backends/agy/role/save", { content: draft });
      setSaved(role);
      setDraft(role.content);
      setFeedback({
        message: role.customized ? "角色设定已保存" : "已恢复默认角色设定",
      });
    } catch (error) {
      setFeedback({ error: true, message: error.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="agy-role-settings" aria-labelledby={heading}>
      <h3 id={heading}>角色设定</h3>
      {saved ? (
        <form onSubmit={save}>
          <textarea
            aria-label="角色设定正文"
            rows={8}
            spellCheck={false}
            readOnly={saving}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setFeedback(null);
            }}
          />
          <div className="agy-save">
            {feedback && (
              <p role={feedback.error ? "alert" : "status"}>
                {feedback.message}
              </p>
            )}
            <button
              type="button"
              disabled={saving || draft === saved.defaultContent}
              onClick={() => {
                setDraft(saved.defaultContent);
                setFeedback(null);
              }}
            >
              载入默认模板
            </button>
            <button
              type="submit"
              disabled={saving || !modified || !draft.trim()}
            >
              {saving ? "正在保存…" : "保存角色设定"}
            </button>
          </div>
        </form>
      ) : feedback ? (
        <div className="agy-save">
          <p role="alert">{feedback.message}</p>
          <button
            type="button"
            onClick={() => setRetry((attempt) => attempt + 1)}
          >
            重新加载
          </button>
        </div>
      ) : (
        <p role="status">正在读取角色设定…</p>
      )}
    </section>
  );
}

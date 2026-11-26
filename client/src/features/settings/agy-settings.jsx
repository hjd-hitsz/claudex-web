import React, { useEffect, useId, useState } from "react";
import { saveBackend, useStoreSelector } from "../../store.js";
import { isModelHidden, modelChoiceLabel } from "../../domain/backends.js";
import { BackendBadge } from "../backends/backend-badge.jsx";
import { reasoningEffortLabels } from "../composer/reasoning-effort.jsx";

const key = ({ providerId = "", model }) => JSON.stringify([providerId, model]);
const executors = [
  ["codex", "Codex"],
  ["claude", "Claude Code"],
];

export function AgySettings({ backend, disabled }) {
  const backends = useStoreSelector((state) => state.backends);
  const models = useStoreSelector((state) => state.modelChoices);
  const stored = JSON.stringify(backend.delegates ?? {});
  const [routes, setRoutes] = useState(() => JSON.parse(stored));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const heading = useId();
  useEffect(() => setRoutes(JSON.parse(stored)), [stored]);
  const modified = JSON.stringify(routes) !== stored;
  const hasMissingModel = executors.some(
    ([id]) => routes[id]?.enabled && !routes[id]?.model,
  );
  function change(id, patch) {
    setFeedback(null);
    setRoutes((previous) => ({
      ...previous,
      [id]: { ...previous[id], ...patch },
    }));
  }
  async function save(event) {
    event.preventDefault();
    if (!modified || hasMissingModel || saving || disabled) return;
    setSaving(true);
    setFeedback(null);
    try {
      await saveBackend({ id: "agy", type: "agy", delegates: routes });
      setFeedback({ message: "委派设置已保存" });
    } catch (error) {
      setFeedback({ error: true, message: error.message });
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="agy-settings" aria-labelledby={heading} onSubmit={save}>
      <h3 id={heading}>委派执行端</h3>
      <fieldset className="agy-routes" disabled={disabled || saving}>
        {executors.map(([id, name]) => {
          const route = routes[id] || {};
          const executor = backends.find((entry) => entry.id === id);
          const choices = models.filter(
            (entry) =>
              entry.backendId === id &&
              !isModelHidden(executor, entry.model, entry.providerId),
          );
          const selected = choices.find((choice) => key(choice) === key(route));
          const efforts = selected?.supportedReasoningEfforts || [];
          const effort = efforts.some(
            ({ reasoningEffort }) => reasoningEffort === route.effort,
          )
            ? route.effort
            : "";
          return (
            <section key={id} className="agy-route" aria-label={name}>
              <label className="agy-route-heading">
                <BackendBadge backendId={id} />
                <span>{name}</span>
                <input
                  className="settings-switch"
                  type="checkbox"
                  checked={route.enabled === true}
                  aria-label={`允许委派给 ${name}`}
                  disabled={!route.enabled && !choices.length}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    const next =
                      choices.find((choice) => choice.isDefault) || choices[0];
                    change(
                      id,
                      enabled && !selected
                        ? {
                            enabled,
                            model: next.model,
                            providerId: next.providerId || "",
                            effort: "",
                          }
                        : { enabled },
                    );
                  }}
                />
              </label>
              {route.enabled && (
                <div className="agy-route-fields">
                  <select
                    aria-label={`${name} 委派模型`}
                    title={
                      selected ? modelChoiceLabel(selected) : "选择委派模型"
                    }
                    value={selected ? key(selected) : ""}
                    disabled={!choices.length}
                    onChange={(event) => {
                      const [providerId, model] = JSON.parse(
                        event.target.value,
                      );
                      change(id, { providerId, model, effort: "" });
                    }}
                  >
                    {!selected && (
                      <option value="" disabled>
                        选择可用模型
                      </option>
                    )}
                    {choices.map((choice) => (
                      <option key={key(choice)} value={key(choice)}>
                        {modelChoiceLabel(choice)}
                      </option>
                    ))}
                  </select>
                  {efforts.length > 0 && (
                    <select
                      className="agy-route-effort"
                      aria-label={`${name} 委派思考强度`}
                      title="思考强度"
                      value={effort}
                      onChange={(event) =>
                        change(id, { effort: event.target.value })
                      }
                    >
                      <option value="">默认</option>
                      {efforts.map(({ reasoningEffort }) => (
                        <option key={reasoningEffort} value={reasoningEffort}>
                          {reasoningEffortLabels[reasoningEffort] ||
                            reasoningEffort}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
              {!choices.length && (
                <p>{executor?.enabled ? "暂无可用模型" : `请先启用 ${name}`}</p>
              )}
            </section>
          );
        })}
      </fieldset>
      <div className="agy-save">
        {feedback && (
          <p role={feedback.error ? "alert" : "status"}>{feedback.message}</p>
        )}
        <button
          type="submit"
          disabled={disabled || saving || !modified || hasMissingModel}
        >
          {saving ? "正在保存…" : "保存委派设置"}
        </button>
      </div>
    </form>
  );
}

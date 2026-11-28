import React, { useEffect, useId, useState } from "react";
import { useStoreSelector, saveBackend } from "../../store.js";
import {
  isModelChoiceHidden,
  isModelHidden,
  modelChoiceLabel,
} from "../../domain/backends.js";
import { reasoningEffortLabels } from "../composer/reasoning-effort.jsx";
import { Check } from "lucide-react";

const choiceKey = (providerId, model) =>
  JSON.stringify([providerId || "", model]);

export function SubagentModelSettings({ backend, disabled }) {
  const modelChoices = useStoreSelector((state) => state.modelChoices);
  const selectId = useId();
  const saved = backend.subagentModel
    ? choiceKey(backend.subagentProviderId, backend.subagentModel)
    : "";
  const [selection, setSelection] = useState(saved);
  const [effort, setEffort] = useState(backend.subagentEffort || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setSelection(saved), [saved]);
  useEffect(
    () => setEffort(backend.subagentEffort || ""),
    [backend.subagentEffort],
  );
  const catalogue = (modelChoices || [])
    .filter((entry) => entry.backendId === backend.id)
    .map((entry) => {
      const nativeClaude = backend.id === "claude" && !entry.providerId;
      return {
        ...entry,
        hidden: isModelChoiceHidden(backend, entry),
        providerId: nativeClaude ? "@native" : entry.providerId,
        model: nativeClaude ? entry.resolvedModel || entry.model : entry.model,
      };
    });
  const choices = catalogue.filter((entry) => !entry.hidden);
  const unavailable =
    selection &&
    !choices.some(
      (entry) => choiceKey(entry.providerId, entry.model) === selection,
    );
  const selected = choices.find(
    (entry) => choiceKey(entry.providerId, entry.model) === selection,
  );
  const efforts = selected?.supportedReasoningEfforts || [];
  const invalidEffort =
    effort && !efforts.some((option) => option.reasoningEffort === effort);
  const [providerId, model] = selection ? JSON.parse(selection) : ["", ""];
  const hidden =
    isModelHidden(backend, model, providerId === "@native" ? "" : providerId) ||
    catalogue.some(
      (entry) =>
        entry.hidden && choiceKey(entry.providerId, entry.model) === selection,
    );
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await saveBackend({
        id: backend.id,
        type: backend.type,
        subagentModel: model,
        subagentEffort: effort,
        ...(backend.type === "claude" && { subagentProviderId: providerId }),
      });
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="backend-form subagent-model-settings"
      aria-label={`${backend.name} 子代理模型`}
      onSubmit={submit}
    >
      <div className="subagent-model-row">
        <label htmlFor={selectId}>子代理模型</label>
        <select
          id={selectId}
          value={unavailable ? "unavailable" : selection}
          disabled={busy || disabled}
          onChange={(event) => {
            const value = event.target.value;
            const next = choices.find(
              (entry) => choiceKey(entry.providerId, entry.model) === value,
            );
            setSelection(value);
            if (
              !next?.supportedReasoningEfforts?.some(
                (option) => option.reasoningEffort === effort,
              )
            )
              setEffort("");
            setError("");
          }}
        >
          <option value="">原生默认</option>
          {unavailable && (
            <option value="unavailable" disabled>
              {hidden ? "已选模型已隐藏" : "已选模型不可用"}
            </option>
          )}
          {choices.map((entry) => (
            <option
              key={choiceKey(entry.providerId, entry.model)}
              value={choiceKey(entry.providerId, entry.model)}
            >
              {modelChoiceLabel(entry)}
            </option>
          ))}
        </select>
        <select
          id={selectId + "-effort"}
          aria-label="子代理思考强度"
          title="思考强度"
          value={invalidEffort ? "unavailable" : effort}
          disabled={busy || disabled || !efforts.length}
          onChange={(event) => {
            setEffort(event.target.value);
            setError("");
          }}
        >
          <option value="">默认强度</option>
          {invalidEffort && (
            <option value="unavailable" disabled>
              已选强度不可用
            </option>
          )}
          {efforts.map(({ reasoningEffort }) => (
            <option key={reasoningEffort} value={reasoningEffort}>
              {reasoningEffortLabels[reasoningEffort] || reasoningEffort}
            </option>
          ))}
        </select>
        <button
          type="submit"
          aria-label={busy ? "正在保存…" : "保存"}
          disabled={
            busy ||
            disabled ||
            unavailable ||
            invalidEffort ||
            (selection === saved && effort === (backend.subagentEffort || ""))
          }
        >
          <span className="subagent-save-label">
            {busy ? "正在保存…" : "保存"}
          </span>
          <Check className="subagent-save-icon" size={14} aria-hidden="true" />
        </button>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

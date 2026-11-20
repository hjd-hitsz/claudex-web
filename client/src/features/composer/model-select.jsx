import React from "react";
import { ChevronDown } from "lucide-react";
import {
  useStoreSelector,
  selectModel,
  selectModelChoice,
  report,
} from "../../store.js";
import { isModelHidden } from "../../domain/backends.js";

const key = (choice) =>
  JSON.stringify([choice.backendId, choice.providerId, choice.model]);
export const ModelSelect = React.memo(function ModelSelect() {
  const backends = useStoreSelector((state) => state.backends);
  const modelChoices = useStoreSelector((state) => state.modelChoices);
  const models = useStoreSelector((state) => state.models);
  const modelId = useStoreSelector((state) => state.model);
  const backendId = useStoreSelector((state) => state.backendId);
  const providerId = useStoreSelector((state) => state.providerId);
  const inConversation = useStoreSelector((state) => Boolean(state.current));
  const active = useStoreSelector((state) =>
    Boolean(state.active[state.current?.id]),
  );
  const locked = useStoreSelector((state) => state.busy || state.loading);
  const backend = backends.find((entry) => entry.id === backendId);
  const hidden = isModelHidden(backend, modelId);
  const choices = (modelChoices || []).filter(
    (choice) =>
      (!inConversation || choice.backendId === backendId) &&
      !isModelHidden(
        backends.find((entry) => entry.id === choice.backendId),
        choice.model,
      ),
  );
  const current = choices.find(
    (choice) =>
      choice.backendId === backendId &&
      choice.providerId === providerId &&
      choice.model === modelId,
  );
  const unavailable = modelId
    ? hidden
      ? `当前模型已隐藏：${modelId}`
      : `当前模型不可用：${modelId}`
    : "请选择模型";
  const catalogueAvailable = choices.length > 0 || hidden;
  const label = current
    ? `${current.providerName} · ${current.displayName || current.model}`
    : catalogueAvailable
      ? unavailable
      : models.find((model) => model.model === modelId)?.displayName ||
        modelId ||
        "请选择模型";
  return (
    <label className="select-control model-select">
      <span className="model-select-value" aria-hidden="true">
        {label}
      </span>
      <select
        aria-label="模型"
        value={current ? key(current) : modelId}
        disabled={locked}
        onChange={(event) => {
          const choice = choices.find(
            (choice) => key(choice) === event.target.value,
          );
          if (choice) selectModelChoice(choice).catch(report);
          else {
            const model = models.find(
              (model) => model.model === event.target.value,
            );
            if (model) selectModel(model);
          }
        }}
      >
        {catalogueAvailable ? (
          <>
            {!current && (
              <option value={modelId} disabled>
                {unavailable}
              </option>
            )}
            {choices.map((choice) => (
              <option
                key={key(choice)}
                value={key(choice)}
                disabled={active && choice.providerId !== providerId}
              >
                {choice.providerName} · {choice.displayName || choice.model}
              </option>
            ))}
          </>
        ) : (
          models
            .filter((model) => !isModelHidden(backend, model.model))
            .map((model) => (
              <option key={model.id} value={model.model}>
                {model.displayName || model.model}
              </option>
            ))
        )}
      </select>
      <ChevronDown size={12} />
    </label>
  );
});

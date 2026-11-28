import React from "react";
import { Check } from "lucide-react";
import {
  isModelChoiceHidden,
  modelChoiceLabel,
  modelProviderName,
} from "../../domain/backends.js";
import { selectModel, useStoreSelector } from "../../store.js";
import { ReasoningEffortControl } from "./reasoning-effort.jsx";
import { ServiceTierToggle } from "./service-tier-toggle.jsx";

export function ModelDialog({ onClose }) {
  const models = useStoreSelector((state) => state.models);
  const selected = useStoreSelector((state) => state.model);
  const providerId = useStoreSelector((state) => state.providerId);
  const providerName = useStoreSelector((state) =>
    modelProviderName(state.modelChoices, state.backendId, providerId),
  );
  const backend = useStoreSelector((state) =>
    state.backends.find((entry) => entry.id === state.backendId),
  );
  const label = (entry) => modelChoiceLabel({ providerName, ...entry });
  const current = models.find((entry) => entry.model === selected) || {
    model: selected,
  };
  return (
    <div className="settings-body">
      <p className="section-description">设置应用于下一条消息。</p>
      {isModelChoiceHidden(backend, { ...current, providerId }) && (
        <p role="status">当前模型已隐藏：{label(current)}</p>
      )}
      <div className="model-options">
        {models
          .filter(
            (model) => !isModelChoiceHidden(backend, { ...model, providerId }),
          )
          .map((model) => (
            <button
              key={model.id}
              className={model.model === selected ? "selected" : ""}
              onClick={() => selectModel(model)}
            >
              <span>
                <b>{label(model)}</b>
                <small>{model.description}</small>
              </span>
              {model.model === selected && <Check size={17} />}
            </button>
          ))}
      </div>
      <ReasoningEffortControl inline />
      <h3>速度模式</h3>
      <ServiceTierToggle />
      <p className="section-description">Fast 模式会增加用量。</p>
      <div className="dialog-done">
        <button className="primary" onClick={onClose}>
          完成
        </button>
      </div>
    </div>
  );
}

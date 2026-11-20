import React, { useId, useRef, useState } from "react";
import {
  CONTEXT_WINDOW_K,
  contextWindowTokens,
} from "../../domain/provider-context-window.js";

const effortLevels = ["low", "medium", "high", "xhigh", "max"];

export function ProviderModels({
  models,
  aliases = {},
  capabilities = {},
  onAliasChange,
  onCapabilityChange,
}) {
  const [selected, setSelected] = useState("");
  const contextId = useId();
  const contextInput = useRef(null);
  const ids = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  const model = ids.includes(selected) ? selected : ids[0];
  if (!model) return null;

  const alias = Object.hasOwn(aliases, model) ? aliases[model] : "";
  const capability = Object.hasOwn(capabilities, model)
    ? capabilities[model]
    : {};
  const supported = capability.supportedEffortLevels ?? [];
  const inK = capability.contextWindowUnit === "k";

  function toggleContextUnit() {
    const tokens = contextWindowTokens(
      capability.contextWindow,
      capability.contextWindowUnit,
    );
    onCapabilityChange(model, {
      contextWindowUnit: inK ? undefined : "k",
      contextWindow:
        tokens == null
          ? capability.contextWindow
          : String(inK ? tokens : tokens / CONTEXT_WINDOW_K),
    });
    contextInput.current.focus();
  }

  return (
    <section className="provider-models" aria-label="模型参数">
      <label className="provider-model-picker">
        <span aria-hidden="true">
          <span className="provider-model-label-prefix">配置</span>模型
        </span>
        <select
          aria-label="配置模型"
          value={model}
          onChange={(event) => setSelected(event.target.value)}
        >
          {ids.map((id) => (
            <option key={id} value={id} title={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      <div className="provider-model-fields">
        <label>
          <span aria-hidden="true">
            <span className="provider-model-label-prefix">显示</span>别名
          </span>
          <input
            aria-label="显示别名"
            value={alias}
            onChange={(event) => onAliasChange(model, event.target.value)}
            placeholder={model}
          />
        </label>
        <div className="provider-context-field">
          <label htmlFor={contextId} aria-hidden="true">
            <span>
              <span className="provider-model-label-prefix">上下文</span>容量
            </span>
          </label>
          <div className="provider-context-control">
            <input
              id={contextId}
              ref={contextInput}
              aria-label="上下文容量"
              className="provider-model-context"
              inputMode={inK ? "decimal" : "numeric"}
              placeholder="自动"
              spellCheck={false}
              value={capability.contextWindow ?? ""}
              onChange={(event) =>
                onCapabilityChange(model, { contextWindow: event.target.value })
              }
            />
            <button
              type="button"
              className="provider-context-unit"
              aria-label="按 k 输入"
              aria-pressed={inK}
              title={
                inK
                  ? "切回完整数字"
                  : `按 k 输入（1k = ${CONTEXT_WINDOW_K} tokens）`
              }
              onClick={toggleContextUnit}
            >
              k
            </button>
          </div>
        </div>
      </div>
      <div className="provider-effort" role="group" aria-label="思考强度">
        <span>思考强度</span>
        <div className="provider-effort-axis">
          {effortLevels.map((level) => (
            <label className="provider-effort-option" key={level}>
              <input
                type="checkbox"
                checked={supported.includes(level)}
                onChange={(event) => {
                  const checked = event.target.checked;
                  onCapabilityChange(model, {
                    supportedEffortLevels: effortLevels.filter((effort) =>
                      effort === level ? checked : supported.includes(effort),
                    ),
                  });
                }}
              />
              <span className="provider-effort-dot" aria-hidden="true" />
              <span>{level}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="provider-model-flags">
        <label className="backend-checkbox">
          <input
            type="checkbox"
            checked={Boolean(capability.supportsFastMode)}
            onChange={(event) =>
              onCapabilityChange(model, {
                supportsFastMode: event.target.checked,
              })
            }
          />
          支持快速模式
        </label>
        <label className="backend-checkbox">
          <input
            type="checkbox"
            checked={Boolean(capability.supportsAdaptiveThinking)}
            onChange={(event) =>
              onCapabilityChange(model, {
                supportsAdaptiveThinking: event.target.checked,
              })
            }
          />
          支持自适应思考
        </label>
      </div>
    </section>
  );
}

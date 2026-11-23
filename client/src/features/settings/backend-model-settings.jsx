import React, { useEffect, useId, useState } from "react";
import { useStoreSelector, rpc, saveBackend } from "../../store.js";
import {
  isModelHidden,
  modelChoiceLabel,
  modelVisibilityKey,
} from "../../domain/backends.js";

const tiers = ["Astra", "Sol", "Terra", "Luna"];
const generationOrder = new Intl.Collator("en", { numeric: true });

function organizeModels(models) {
  const generations = new Map();
  const otherModels = [];
  for (const model of models) {
    const match = /^gpt-(\d+(?:\.\d+)*)-(astra|sol|terra|luna)$/.exec(
      model.model,
    );
    if (!match) {
      otherModels.push(model);
      continue;
    }
    const [, generation, tier] = match;
    if (!generations.has(generation)) generations.set(generation, new Map());
    generations.get(generation).set(tier, model);
  }
  return {
    generations: [...generations].sort(([a], [b]) =>
      generationOrder.compare(b, a),
    ),
    otherModels,
  };
}

export function BackendModelSettings({ backend }) {
  const cwd = useStoreSelector((state) => state.cwd);
  const catalogue = useStoreSelector((state) => state.modelChoices);
  const codex = backend.id === "codex";
  const titleId = useId();
  const [codexModels, setCodexModels] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!codex) return;
    let active = true;
    rpc("model/list", { backendId: backend.id, cwd }).then(
      (result) => {
        if (active) {
          setCodexModels(result.data);
          setError("");
        }
      },
      (error) => {
        if (active) setError(error.message);
      },
    );
    return () => {
      active = false;
    };
  }, [codex, backend.id, backend.ready, cwd]);
  async function toggle(models, shown) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const hidden = new Set(backend.hiddenModels || []);
      for (const model of models) {
        const key = modelVisibilityKey(model.model, model.providerId);
        if (shown) hidden.delete(key);
        else hidden.add(key);
      }
      await saveBackend({
        id: backend.id,
        type: backend.type,
        hiddenModels: [...hidden],
      });
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  const models = codex
    ? codexModels
    : catalogue?.filter((entry) => entry.backendId === backend.id);
  const { generations, otherModels } = codex
    ? organizeModels(models || [])
    : { generations: [], otherModels: models || [] };
  const shown = (models || []).filter(
    (model) => !isModelHidden(backend, model.model, model.providerId),
  ).length;
  function option(model, showName = false) {
    const name = modelChoiceLabel(
      codex ? { ...model, providerName: "ChatGPT" } : model,
    );
    return (
      <label className="codex-model-option" title={name}>
        <input
          type="checkbox"
          aria-label={name}
          aria-disabled={busy || undefined}
          checked={!isModelHidden(backend, model.model, model.providerId)}
          onChange={(event) => toggle([model], event.target.checked)}
        />
        {showName && name}
      </label>
    );
  }
  return (
    <section className="backend-model-settings" aria-labelledby={titleId}>
      <div className="backend-model-heading">
        <h3 id={titleId}>显示的模型</h3>
        {!codex && models?.length > 0 && (
          <label className="backend-checkbox">
            <input
              type="checkbox"
              checked={shown === models.length}
              ref={(input) => {
                if (input)
                  input.indeterminate = shown > 0 && shown < models.length;
              }}
              disabled={busy}
              onChange={(event) => toggle(models, event.target.checked)}
            />
            全选
          </label>
        )}
      </div>
      {generations.length > 0 && (
        <table className="codex-model-generations" aria-labelledby={titleId}>
          <thead>
            <tr>
              <th scope="col">代际</th>
              {tiers.map((tier) => (
                <th key={tier} scope="col">
                  {tier}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {generations.map(([generation, modelsByTier]) => (
              <tr key={generation}>
                <th scope="row">GPT-{generation}</th>
                {tiers.map((tier) => {
                  const model = modelsByTier.get(tier.toLowerCase());
                  return (
                    <td key={tier}>
                      {model ? (
                        option(model)
                      ) : (
                        <span
                          className="codex-model-unavailable"
                          title="不可用"
                        >
                          <span aria-hidden="true">—</span>
                          <span className="codex-model-unavailable-text">
                            不可用
                          </span>
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {otherModels.length > 0 && (
        <div className="codex-other-models">
          {generations.length > 0 && <h4>其他模型</h4>}
          <ul>
            {otherModels.map((model) => (
              <li key={modelVisibilityKey(model.model, model.providerId)}>
                {option(model, true)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {models?.length === 0 && !error && <p>暂无可用模型</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

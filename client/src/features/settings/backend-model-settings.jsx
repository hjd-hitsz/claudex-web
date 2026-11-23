import React, { useEffect, useId, useState } from "react";
import { useStoreSelector, rpc, set } from "../../store.js";
import { isModelHidden, modelVisibilityKey } from "../../domain/backends.js";

const tiers = ["Astra", "Sol", "Terra", "Luna"];
const generationOrder = new Intl.Collator("en", { numeric: true });

function organizeModels(models) {
  const generations = new Map();
  const otherModels = [];
  for (const model of models) {
    const match =
      !model.providerId &&
      /^gpt-(\d+(?:\.\d+)*)-(astra|sol|terra|luna)$/.exec(model.model);
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
  const titleId = useId();
  const [models, setModels] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    async function load() {
      const native = await rpc("model/list", {
        backendId: backend.id,
        cwd,
        providerId: "",
      });
      if (backend.id !== "claude") return native;
      const { providers } = await rpc("lan/providers/list", {
        backendId: "claude",
      });
      const catalogues = await Promise.all(
        providers.map(async (provider) => {
          const result = await rpc("model/list", {
            backendId: "claude",
            providerId: provider.id,
            cwd,
          });
          return result.data.map((model) => ({
            ...model,
            providerId: provider.id,
            displayName: `${provider.name}/${model.displayName || model.model}`,
          }));
        }),
      );
      return { data: [...native.data, ...catalogues.flat()] };
    }
    load().then(
      (result) => {
        if (active) {
          setModels(result.data);
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
  }, [backend.id, backend.ready, cwd]);
  async function toggle(ids, shown) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const hidden = new Set(backend.hiddenModels || []);
      for (const id of ids) {
        if (shown) hidden.delete(id);
        else hidden.add(id);
      }
      const result = await rpc("lan/backends/save", {
        id: backend.id,
        type: backend.type,
        hiddenModels: [...hidden],
      });
      set({ backends: result.backends });
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  const { generations, otherModels } = organizeModels(models || []);
  const shownCount = (models || []).filter(
    (model) => !isModelHidden(backend, model.model, model.providerId),
  ).length;
  function option(model, label) {
    const name = model.displayName || model.model;
    return (
      <label className="codex-model-option" title={name}>
        <input
          type="checkbox"
          aria-label={name}
          aria-disabled={busy || undefined}
          checked={!isModelHidden(backend, model.model, model.providerId)}
          onChange={(event) =>
            toggle(
              [modelVisibilityKey(model.model, model.providerId)],
              event.target.checked,
            )
          }
        />
        {label}
      </label>
    );
  }
  return (
    <section className="codex-model-settings" aria-labelledby={titleId}>
      <div className="backend-model-heading">
        <h3 id={titleId}>显示的模型</h3>
        {["claude", "opencode"].includes(backend.id) && models?.length > 0 && (
          <label className="backend-checkbox">
            <input
              type="checkbox"
              checked={shownCount === models.length}
              ref={(input) => {
                if (input)
                  input.indeterminate =
                    shownCount > 0 && shownCount < models.length;
              }}
              disabled={busy}
              onChange={(event) =>
                toggle(
                  models.map((model) =>
                    modelVisibilityKey(model.model, model.providerId),
                  ),
                  event.target.checked,
                )
              }
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
                {option(model, model.displayName || model.model)}
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

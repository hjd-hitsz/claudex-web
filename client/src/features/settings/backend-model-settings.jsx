import React, { useEffect, useId, useState } from "react";
import {
  useStoreSelector,
  rpc,
  readAgyCatalogue,
  saveBackend,
} from "../../store.js";
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

export function BackendModelSettings({ backend, active = true }) {
  const cwd = useStoreSelector((state) => state.cwd);
  const catalogue = useStoreSelector((state) => state.modelChoices);
  const codex = backend.id === "codex";
  const agy = backend.id === "agy";
  const claude = backend.id === "claude";
  const fetchCatalogue =
    codex || ((agy || claude) && active && backend.enabled && backend.ready);
  const titleId = useId();
  const [nativeModels, setNativeModels] = useState(null);
  const [needsSubscription, setNeedsSubscription] = useState(false);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!fetchCatalogue) return;
    let current = true;
    setLoading(true);
    setError("");
    setNeedsSubscription(false);
    setNativeModels(null);
    const read = agy
      ? readAgyCatalogue(cwd).then((data) => ({ data }))
      : rpc("model/list", {
          backendId: backend.id,
          cwd,
          ...(claude && { nativeSubscriptionOnly: true }),
        });
    read.then(
      ({ data, nativeSubscription }) => {
        if (current) {
          setNeedsSubscription(claude && nativeSubscription === false);
          if (claude && nativeSubscription === undefined)
            setError("Claude Code 原生模型目录返回了未知状态");
          if (!agy) setNativeModels(claude && !nativeSubscription ? [] : data);
          setLoading(false);
        }
      },
      (error) => {
        if (current) {
          setNativeModels(null);
          setLoading(false);
          setError(
            claude ? `原生模型目录读取失败：${error.message}` : error.message,
          );
        }
      },
    );
    return () => {
      current = false;
    };
  }, [agy, claude, fetchCatalogue, backend.id, backend.ready, cwd, retry]);
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
  const models =
    (agy || claude) && !fetchCatalogue
      ? null
      : codex || claude
        ? nativeModels
        : catalogue?.filter((entry) => entry.backendId === backend.id);
  const { generations, otherModels } = codex
    ? organizeModels(models || [])
    : { generations: [], otherModels: models || [] };
  const shown = (models || []).filter(
    (model) => !isModelHidden(backend, model.model, model.providerId),
  ).length;
  function option(model, showName = false) {
    const name = agy
      ? model.displayName || model.model
      : modelChoiceLabel(codex ? { ...model, providerName: "ChatGPT" } : model);
    return (
      <label className="codex-model-option" title={name}>
        <input
          type="checkbox"
          aria-label={name}
          aria-disabled={busy || undefined}
          checked={!isModelHidden(backend, model.model, model.providerId)}
          onChange={(event) => toggle([model], event.target.checked)}
        />
        {showName && (agy ? model.displayName || model.model : name)}
      </label>
    );
  }
  return (
    <section className="backend-model-settings" aria-labelledby={titleId}>
      <div className="backend-model-heading">
        <h3 id={titleId}>{claude ? "显示的原生 Claude 模型" : "显示的模型"}</h3>
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
      {models?.length === 0 && !loading && !error && (
        <p>
          {needsSubscription
            ? "登录 Claude 订阅后可选择原生模型"
            : "暂无可用模型"}
        </p>
      )}
      {(agy || claude) &&
        (!models || (loading && !models.length)) &&
        !error && (
          <p role="status">
            {fetchCatalogue || loading
              ? "正在读取原生模型…"
              : "后端连接后显示可用模型"}
          </p>
        )}
      {error && (
        <div className="backend-model-error">
          <p className="inline-error" role="alert">
            {error}
          </p>
          {(agy || claude) && fetchCatalogue && (
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              重试
            </button>
          )}
        </div>
      )}
    </section>
  );
}

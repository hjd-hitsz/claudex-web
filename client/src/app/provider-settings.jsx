import { ResizableTextarea } from "../ui/resizable-textarea.jsx";
import React, { useEffect, useId, useState } from "react";
import { ProviderModels } from "./provider-models.jsx";
import { PresetProviderForm } from "./preset-provider-form.jsx";
import { rpc, saveProvider, removeProvider } from "../store.js";
import { contextWindowTokens } from "../domain/provider-context-window.js";

export function ProviderSettings({ backend }) {
  const apiKeyId = useId();
  const [providers, setProviders] = useState([]),
    [editing, setEditing] = useState(null),
    [error, setError] = useState(""),
    [saveError, setSaveError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    rpc("lan/providers/list", { backendId: backend.id, includeDisabled: true })
      .then((r) => {
        if (current) setProviders(r.providers);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [backend.id]);
  function beginEditing(provider) {
    setSaveError("");
    setEditing(provider);
  }
  const editor =
    editing &&
    (editing.preset ? (
      <PresetProviderForm
        key={editing.id}
        provider={editing}
        busy={busy}
        setBusy={setBusy}
        backendId={backend.id}
        onSaved={(providers) => {
          setProviders(providers);
          beginEditing(null);
        }}
        onCancel={() => beginEditing(null)}
      />
    ) : (
      <form
        className="backend-form provider-editor"
        key={editing.id || "new"}
        onSubmit={async (event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          setBusy(true);
          setSaveError("");
          try {
            const key = values.get("apiKey");
            const models = editing.models
              .map((model) => model.trim())
              .filter(Boolean);
            await saveProvider({
              id: editing.id,
              backendId: backend.id,
              name: values.get("name"),
              baseUrl: values.get("baseUrl"),
              protocol: values.get("protocol"),
              modelAliases: Object.fromEntries(
                Object.entries(editing.modelAliases || {}).filter(([model]) =>
                  models.includes(model),
                ),
              ),
              modelCapabilities: Object.fromEntries(
                models.map((model) => {
                  const capability = editing.modelCapabilities?.[model];
                  const contextWindow = contextWindowTokens(
                    capability?.contextWindow,
                    capability?.contextWindowUnit,
                  );
                  if (contextWindow === null)
                    throw new Error(
                      `模型「${model}」的上下文容量需换算为正整数，例如直接输入 32768，或点亮 k 后输入 32。`,
                    );
                  return [
                    model,
                    {
                      ...(contextWindow !== undefined && { contextWindow }),
                      supportedEffortLevels:
                        capability?.supportedEffortLevels ?? [],
                      supportsFastMode: Boolean(capability?.supportsFastMode),
                      supportsAdaptiveThinking: Boolean(
                        capability?.supportsAdaptiveThinking,
                      ),
                    },
                  ];
                }),
              ),
              models,
              ...(values.has("clearKey")
                ? { apiKey: "" }
                : key
                  ? { apiKey: key }
                  : {}),
            });
            setProviders(
              (
                await rpc("lan/providers/list", {
                  backendId: backend.id,
                  includeDisabled: true,
                })
              ).providers,
            );
            beginEditing(null);
          } catch (e) {
            setSaveError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="provider-fields">
          <label>
            <span>名称</span>
            <input name="name" required defaultValue={editing.name} />
          </label>
          <label>
            <span aria-hidden="true">
              <span className="provider-field-prefix">API </span>协议
            </span>
            <select
              aria-label="API 协议"
              name="protocol"
              defaultValue={editing.protocol || "anthropic"}
            >
              <option value="anthropic">Message API</option>
              <option value="messages">Message API （兼容）</option>
            </select>
          </label>
          <label>
            <span aria-hidden="true">
              <span className="provider-field-prefix">API </span>地址
            </span>
            <input
              aria-label="API 地址"
              name="baseUrl"
              type="url"
              required
              defaultValue={editing.baseUrl}
            />
          </label>
          <div className="provider-key-field">
            <label htmlFor={apiKeyId} aria-hidden="true">
              <span>
                <span className="provider-field-prefix">API </span>Key
              </span>
            </label>
            <input
              id={apiKeyId}
              aria-label="API Key"
              name="apiKey"
              type="password"
              autoComplete="new-password"
              placeholder={editing.hasApiKey ? "已配置；留空保留" : "可留空"}
            />
            {editing.hasApiKey && (
              <label className="backend-checkbox" title="清除已保存凭据">
                <input
                  name="clearKey"
                  type="checkbox"
                  aria-label="清除已保存凭据"
                />
                清除
              </label>
            )}
          </div>
        </div>
        <label>
          模型标识（每行一个）
          <ResizableTextarea
            name="models"
            required
            value={editing.models.join("\n")}
            onChange={(event) =>
              setEditing({
                ...editing,
                models: event.target.value.split(/\r?\n/),
              })
            }
            rows={2}
          />
        </label>
        <ProviderModels
          models={editing.models}
          aliases={editing.modelAliases}
          capabilities={editing.modelCapabilities}
          onAliasChange={(model, alias) =>
            setEditing((draft) => ({
              ...draft,
              modelAliases: { ...draft.modelAliases, [model]: alias },
            }))
          }
          onCapabilityChange={(model, changes) =>
            setEditing((draft) => ({
              ...draft,
              modelCapabilities: {
                ...draft.modelCapabilities,
                [model]: { ...draft.modelCapabilities?.[model], ...changes },
              },
            }))
          }
        />
        {saveError && <p role="alert">{saveError}</p>}
        <div className="provider-editor-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => beginEditing(null)}
          >
            取消
          </button>
          <button type="submit" className="primary" disabled={busy}>
            保存供应商
          </button>
        </div>
      </form>
    ));
  return (
    <div className="provider-settings">
      {providers.map((p) => (
        <div className="provider-entry" key={p.id}>
          <div className="backend-heading">
            <span className="provider-identity">
              {p.preset && (
                <>
                  <img
                    className="provider-brand-symbol"
                    src={
                      new URL(
                        `../assets/providers/${p.icon}.svg`,
                        import.meta.url,
                      ).href
                    }
                    alt={`${p.name} 标识`}
                  />
                </>
              )}
              <span>{p.name}</span>
            </span>
            {p.preset && (
              <span>{p.hasApiKey ? "已启用" : "待填写 API Key"}</span>
            )}
            <div className="provider-actions">
              <button
                aria-expanded={editing?.id === p.id}
                disabled={busy}
                onClick={() => beginEditing(editing?.id === p.id ? null : p)}
              >
                编辑
              </button>
              {!p.preset && (
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      const result = await removeProvider({ id: p.id });
                      setProviders(result.providers);
                      if (editing?.id === p.id) beginEditing(null);
                    } catch (error) {
                      setError(error.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  删除
                </button>
              )}
            </div>
          </div>
          {editing?.id === p.id && editor}
        </div>
      ))}
      <button
        disabled={busy}
        aria-expanded={Boolean(editing && !editing.id)}
        onClick={() =>
          beginEditing(
            editing && !editing.id
              ? null
              : { name: "", baseUrl: "", models: [] },
          )
        }
      >
        添加供应商
      </button>
      {editing && !editing.id && editor}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

import React, { useEffect, useEffectEvent, useRef, useState } from "react";
import { refreshProvider, saveProvider } from "../../store.js";
import { ProviderCredentials } from "./provider-credentials.jsx";
import { ProviderModelVisibility } from "./provider-model-visibility.jsx";

export function PresetProviderForm({
  provider,
  backendId,
  busy,
  setBusy,
  onSaved,
  onCatalogue,
  onCancel,
}) {
  const [error, setError] = useState("");
  const [directory, setDirectory] = useState(provider);
  const [preview, setPreview] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const revision = useRef(0);
  const [hiddenModels, setHiddenModels] = useState(provider.hiddenModels || []);
  const catalogue = preview || directory;
  const canRefresh = !clearKey && Boolean(apiKey.trim() || provider.hasApiKey);
  const catalogueMessage = refreshing
    ? "正在刷新模型…"
    : refreshError || (preview ? "预览，保存后生效" : "");
  async function refresh(key) {
    const request = ++revision.current;
    setRefreshing(true);
    setRefreshError("");
    try {
      const result = await refreshProvider({
        id: provider.id,
        ...(key && { apiKey: key }),
      });
      if (request !== revision.current) return;
      const models = result.provider;
      if (result.preview) setPreview(models);
      else {
        setDirectory(models);
        setPreview(null);
        onCatalogue(models);
        setHiddenModels((hidden) =>
          hidden.filter((id) => models.models.includes(id)),
        );
      }
    } catch (error) {
      if (request === revision.current) setRefreshError(error.message);
    } finally {
      if (request === revision.current) setRefreshing(false);
    }
  }
  const refreshOnOpen = useEffectEvent(() => refresh(""));
  useEffect(() => {
    if (provider.canRefreshModels && provider.hasApiKey) refreshOnOpen();
    return () => {
      revision.current++;
    };
  }, [provider.id, provider.canRefreshModels, provider.hasApiKey]);
  function resetPreview() {
    revision.current++;
    setPreview(null);
    setRefreshing(false);
    setRefreshError("");
  }
  return (
    <form
      className="backend-form provider-editor"
      onSubmit={async (event) => {
        event.preventDefault();
        revision.current++;
        setRefreshing(false);
        setBusy(true);
        setError("");
        try {
          const result = await saveProvider({
            id: provider.id,
            backendId,
            ...(clearKey
              ? { apiKey: "" }
              : apiKey.trim()
                ? { apiKey: apiKey.trim() }
                : {}),
            hiddenModels: hiddenModels.filter((id) =>
              catalogue.models.includes(id),
            ),
          });
          onSaved(result.catalogueError);
        } catch (error) {
          setError(error.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ProviderCredentials
        hasApiKey={provider.hasApiKey}
        busy={busy}
        onCancel={onCancel}
        apiKey={apiKey}
        onKeyChange={(event) => {
          setApiKey(event.target.value);
          resetPreview();
        }}
        onClearChange={(event) => {
          setClearKey(event.target.checked);
          resetPreview();
        }}
      />
      {error && <p role="alert">{error}</p>}
      <ProviderModelVisibility
        models={catalogue.models}
        aliases={catalogue.modelAliases}
        hiddenModels={hiddenModels}
        disabled={busy}
        onChange={setHiddenModels}
        catalogueControls={
          provider.canRefreshModels && (
            <div className="provider-catalogue-status">
              {catalogueMessage && (
                <p role={refreshError ? "alert" : "status"}>
                  {catalogueMessage}
                </p>
              )}
              <button
                type="button"
                disabled={busy || refreshing || !canRefresh}
                onClick={() => refresh(apiKey.trim())}
              >
                刷新模型
              </button>
            </div>
          )
        }
      />
    </form>
  );
}

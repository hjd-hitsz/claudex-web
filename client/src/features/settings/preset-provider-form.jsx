import React, { useState } from "react";
import { saveProvider } from "../../store.js";

export function PresetProviderForm({
  provider,
  backendId,
  busy,
  setBusy,
  onSaved,
  onCancel,
}) {
  const [error, setError] = useState("");
  return (
    <form
      className="backend-form provider-editor"
      onSubmit={async (event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        setBusy(true);
        setError("");
        try {
          await saveProvider({
            id: provider.id,
            backendId,
            apiKey: String(values.get("apiKey") || "").trim(),
          });
          onSaved();
        } catch (error) {
          setError(error.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        API Key
        <input
          name="apiKey"
          type="password"
          autoComplete="new-password"
          placeholder="填写后启用；保存空值清除凭据并停用"
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="provider-editor-actions">
        <button type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="primary" disabled={busy}>
          保存供应商
        </button>
      </div>
    </form>
  );
}

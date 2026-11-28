import React from "react";

export function ProviderCredentials({
  hasApiKey,
  busy,
  onCancel,
  apiKey,
  onKeyChange,
  onClearChange,
}) {
  return (
    <div className="provider-credentials">
      <label className="provider-credential-key">
        <span>API Key</span>
        <input
          name="apiKey"
          type="password"
          autoComplete="new-password"
          placeholder={hasApiKey ? "已配置，留空保留" : "填写后启用"}
          disabled={busy}
          value={apiKey}
          onChange={onKeyChange}
        />
      </label>
      {hasApiKey && (
        <label className="backend-checkbox" title="清除已保存凭据">
          <input
            name="clearKey"
            type="checkbox"
            aria-label="清除已保存凭据"
            disabled={busy}
            onChange={onClearChange}
          />
          清除凭据
        </label>
      )}
      <div className="provider-editor-actions">
        <button type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="primary" disabled={busy}>
          保存供应商
        </button>
      </div>
    </div>
  );
}

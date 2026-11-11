import React, { useState } from "react";
import { useStore, setThinkingTranslation } from "../store.js";
export function TranslationSettings() {
  const { translation } = useStore();
  const [saving, setSaving] = useState(false);
  async function update(enabled) {
    setSaving(true);
    try {
      await setThinkingTranslation(enabled);
    } finally {
      setSaving(false);
    }
  }
  const progress = translation.progress;
  return (
    <div className="translation-settings">
      <label>
        <input
          type="checkbox"
          checked={translation.enabled}
          disabled={saving}
          onChange={(event) => update(event.target.checked)}
        />
        思考内容翻译
      </label>
      {translation.enabled &&
        ["preparing", "downloading"].includes(translation.state) && (
          <div role="status">
            <span>
              {progress?.stage === "downloading"
                ? "正在下载翻译模型"
                : "正在准备翻译"}
            </span>
            {progress?.total > 0 && progress.stage === "downloading" && (
              <>
                <progress
                  value={progress.received}
                  max={progress.total}
                  aria-label="翻译模型下载进度"
                />
                <span>
                  {Math.round((progress.received / progress.total) * 100)}%
                </span>
              </>
            )}
          </div>
        )}
      {translation.enabled && translation.error && (
        <div className="inline-error" role="alert">
          {translation.error}
          <button
            className="secondary"
            disabled={saving}
            onClick={() => update(true)}
          >
            重试
          </button>
        </div>
      )}
    </div>
  );
}

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
      <p className="section-description">
        消息接收完整后在服务器本地翻译。首次开启会下载约 300 MB 的英译中模型和
        CPU 运行库，等待期间继续显示原文。
      </p>
      {translation.enabled &&
        ["preparing", "downloading"].includes(translation.state) && (
          <div role="status">
            <span>
              {["extracting", "runtime"].includes(progress?.stage)
                ? "正在准备模型"
                : "正在下载翻译模型"}
            </span>
            {progress?.total > 0 && progress.stage !== "runtime" && (
              <progress value={progress.received} max={progress.total} />
            )}
            {progress?.total > 0 && (
              <span>
                {Math.round((progress.received / progress.total) * 100)}%
              </span>
            )}
          </div>
        )}
      {translation.enabled && translation.state === "ready" && (
        <p className="section-description">本地模型已就绪</p>
      )}
      {translation.enabled && translation.error && (
        <div className="inline-error">
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
      {translation.modelDirectory && (
        <details>
          <summary>模型存储位置</summary>
          <code>{translation.modelDirectory}</code>
          <p className="section-description">
            模型独立于程序安装目录保存，升级后继续复用，关闭翻译后保留下载。
          </p>
        </details>
      )}
    </div>
  );
}

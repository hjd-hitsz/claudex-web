import React, { useState } from "react";
import { saveBackend } from "../store.js";

export function BackgroundTerminalSetting({ backend }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const available = backend?.backgroundTerminalAvailable === true;
  async function toggle(enabled) {
    setSaving(true);
    setError("");
    try {
      await saveBackend({
        id: "codex",
        type: "codex",
        backgroundTerminalEnabled: enabled,
      });
    } catch (error) {
      setError(error.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="background-terminal-setting" aria-busy={saving}>
      <label>
        <input
          type="checkbox"
          checked={Boolean(available && backend.backgroundTerminalEnabled)}
          disabled={saving || !available}
          onChange={(event) => toggle(event.target.checked)}
        />
        为Codex开启后台终端功能
      </label>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </div>
  );
}

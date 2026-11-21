import React, { useState } from "react";
import { saveBackend } from "../../store.js";

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
      <label htmlFor="settings-background-terminal">Codex 后台终端</label>
      <input
        id="settings-background-terminal"
        className="settings-switch"
        type="checkbox"
        checked={Boolean(available && backend.backgroundTerminalEnabled)}
        disabled={saving || !available}
        onChange={(event) => toggle(event.target.checked)}
      />
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </div>
  );
}

import React, { useState } from "react";
import { saveBackend } from "../../store.js";

export function BackendToggleSetting({
  id,
  label,
  backend,
  preference,
  available = Boolean(backend),
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function toggle(enabled) {
    setSaving(true);
    setError("");
    try {
      await saveBackend({
        id: backend.id,
        type: backend.type,
        [preference]: enabled,
      });
    } catch (error) {
      setError(error.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div aria-busy={saving}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="settings-switch"
        type="checkbox"
        checked={Boolean(available && backend?.[preference])}
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

export function isCodexPreference(input) {
  return (
    input.id === "codex" &&
    ("backgroundTerminalEnabled" in input || "hiddenModels" in input) &&
    Object.keys(input).every((key) =>
      ["id", "type", "backgroundTerminalEnabled", "hiddenModels"].includes(key),
    )
  );
}

export function isModelVisibilityPreference(input) {
  return (
    "hiddenModels" in input &&
    Object.keys(input).every((key) =>
      ["id", "type", "hiddenModels"].includes(key),
    )
  );
}

export function isBackendPreference(input) {
  return isCodexPreference(input) || isModelVisibilityPreference(input);
}

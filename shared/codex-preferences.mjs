export function isCodexPreference(input) {
  return (
    input.id === "codex" &&
    ("backgroundTerminalEnabled" in input || "hiddenModels" in input) &&
    Object.keys(input).every((key) =>
      ["id", "type", "backgroundTerminalEnabled", "hiddenModels"].includes(key),
    )
  );
}

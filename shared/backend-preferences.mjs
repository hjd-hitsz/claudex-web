export function isBackendPreference(input) {
  return (
    ("backgroundTerminalEnabled" in input || "hiddenModels" in input) &&
    Object.keys(input).every((key) =>
      ["id", "type", "backgroundTerminalEnabled", "hiddenModels"].includes(key),
    )
  );
}

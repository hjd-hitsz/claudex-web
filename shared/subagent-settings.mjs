const fields = ["subagentModel", "subagentProviderId", "subagentEffort"];

export function subagentSettings(backend) {
  return Object.fromEntries(fields.map((key) => [key, backend[key] || ""]));
}

export function isSubagentSettings(input) {
  return (
    fields.some((key) => Object.hasOwn(input, key)) &&
    Object.keys(input).every((key) => ["id", "type", ...fields].includes(key))
  );
}

export function executionBackend(backend) {
  return Object.fromEntries(
    Object.entries(backend).filter(([key]) => !fields.includes(key)),
  );
}

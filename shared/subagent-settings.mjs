const fields = ["subagentModel", "subagentProviderId", "subagentEffort"];

/** @param {{subagentModel?: string, subagentProviderId?: string, subagentEffort?: string}} backend */
export function subagentSettings(backend) {
  return {
    subagentModel: backend.subagentModel || "",
    subagentProviderId: backend.subagentProviderId || "",
    subagentEffort: backend.subagentEffort || "",
  };
}

export function isSubagentSettings(input) {
  return (
    fields.some((key) => Object.hasOwn(input, key)) &&
    Object.keys(input).every((key) => ["id", "type", ...fields].includes(key))
  );
}

export function executionBackend(backend) {
  return Object.fromEntries(
    Object.entries(backend).filter(
      ([key]) => key !== "hiddenModels" && !fields.includes(key),
    ),
  );
}

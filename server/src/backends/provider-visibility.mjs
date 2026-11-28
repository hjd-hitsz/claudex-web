import { providerPresets } from "./provider-presets.mjs";

function providerModelKey(key) {
  if (typeof key !== "string" || !key.startsWith("[")) return null;
  try {
    const pair = JSON.parse(key);
    return Array.isArray(pair) &&
      pair.length === 2 &&
      pair.every((part) => typeof part === "string" && part.trim())
      ? pair
      : null;
  } catch {
    return null;
  }
}

// Old backend preferences stay readable until the next atomic configuration write.
export function migrateProviderVisibility(data) {
  const claude = data.backends.find((backend) => backend.id === "claude");
  if (!Array.isArray(claude?.hiddenModels)) return data;
  const providers = new Map((data.providers || []).map((row) => [row.id, row]));
  const presets = new Map(providerPresets.map((row) => [row.id, row]));
  const migrated = new Map();
  const hiddenModels = [];
  let changed = false;
  for (const key of claude.hiddenModels) {
    const [id, model] = providerModelKey(key) || [];
    const provider = providers.get(id) || presets.get(id);
    if (provider?.backendId === "claude") {
      if (!Array.isArray(providers.get(id)?.hiddenModels)) {
        if (!migrated.has(id)) migrated.set(id, new Set());
        migrated.get(id).add(model);
      }
      changed = true;
    } else if (id === "@native") {
      hiddenModels.push(model);
      changed = true;
    } else {
      hiddenModels.push(key);
    }
  }
  for (const [id, hidden] of migrated)
    providers.set(id, {
      id,
      backendId: "claude",
      ...providers.get(id),
      hiddenModels: [...hidden],
    });
  return changed
    ? {
        ...data,
        backends: data.backends.map((backend) =>
          backend === claude
            ? { ...backend, hiddenModels: [...new Set(hiddenModels)] }
            : backend,
        ),
        providers: [...providers.values()],
      }
    : data;
}

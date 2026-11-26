import { validateDelegationSettings } from "../delegation/settings.mjs";
import { join } from "node:path";
import { validateNetworkProxy } from "../network-proxy.mjs";

export const agyStateDirectory = (configDir) =>
  join(configDir, "backends", "agy");

export function validateAgyBackend(input, config) {
  const delegation = validateDelegationSettings(input);
  if (
    input.hiddenModels !== undefined &&
    (!Array.isArray(input.hiddenModels) ||
      input.hiddenModels.some((id) => typeof id !== "string" || !id.trim()))
  )
    throw new Error("隐藏模型列表无效");
  const stateDir = agyStateDirectory(config.configDir);
  return {
    id: "agy",
    type: "agy",
    name: "Antigravity",
    enabled: input.enabled === true,
    executable: "agy",
    stateDir,
    dataDir: stateDir,
    proxy: validateNetworkProxy(input.proxy),
    ...delegation,
    hiddenModels: [...new Set(input.hiddenModels || [])],
  };
}

const preferences = [
  "delegates",
  "hiddenModels",
  "delegationPrompts",
  "delegationSourcePrompts",
];

export const isAgyPreference = (p) =>
  p.id === "agy" &&
  preferences.some((key) => key in p) &&
  Object.keys(p).every((key) => ["id", "type", ...preferences].includes(key));

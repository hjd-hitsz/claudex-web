import { join } from "node:path";
import { validateNetworkProxy } from "../network-proxy.mjs";

export const agyStateDirectory = (configDir) =>
  join(configDir, "backends", "agy");

export function validateAgyBackend(input, config) {
  const delegates = {};
  const valid = ["codex", "claude"];
  if (Object.keys(input.delegates || {}).some((id) => !valid.includes(id)))
    throw new Error("委派执行端无效");
  for (const id of valid) {
    const {
      enabled = false,
      model = "",
      effort = "",
      providerId = "",
    } = input.delegates?.[id] || {};
    if (
      typeof enabled !== "boolean" ||
      [model, effort, providerId].some(
        (value) =>
          typeof value !== "string" ||
          /[\s\x00-\x1f\x7f]/u.test(value) ||
          value.length > 256,
      ) ||
      (id === "codex" && providerId) ||
      (enabled && !model)
    )
      throw new Error("请为启用的委派执行端选择有效的模型");
    delegates[id] = { enabled, model, effort, providerId };
  }
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
    delegates,
    hiddenModels: [...new Set(input.hiddenModels || [])],
  };
}

export const isAgyPreference = (p) =>
  p.id === "agy" &&
  ("delegates" in p || "hiddenModels" in p) &&
  Object.keys(p).every((key) =>
    ["id", "type", "delegates", "hiddenModels"].includes(key),
  );

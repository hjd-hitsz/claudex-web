import { providerPresets } from "./provider-presets.mjs";

export const backendConfigVersion = 2;

export function validateProviderProtocol(protocol) {
  if (
    protocol !== undefined &&
    !["messages", "messages_compatible"].includes(protocol)
  )
    throw new Error("请选择支持的 API 协议");
}

export function migrateProviderProtocols(data) {
  const { version, providers = [] } = data;
  if (!Array.isArray(data.backends) || !Array.isArray(providers))
    throw new Error("后端配置格式无效");
  if (version === backendConfigVersion) {
    for (const provider of providers)
      validateProviderProtocol(provider.protocol);
    return data;
  }
  if (version !== undefined && version !== 1)
    throw new Error("后端配置版本不受支持");
  return {
    ...data,
    version: backendConfigVersion,
    providers: providers.map((provider) => {
      const { id, protocol } = provider;
      // Version 1 and unversioned files used compatibility by default.
      if (
        protocol !== undefined &&
        !["anthropic", "messages"].includes(protocol)
      )
        throw new Error("请选择支持的 API 协议");
      const native =
        protocol === "anthropic" ||
        providerPresets.some((preset) => preset.id === id);
      return {
        ...provider,
        protocol: native ? "messages" : "messages_compatible",
      };
    }),
  };
}

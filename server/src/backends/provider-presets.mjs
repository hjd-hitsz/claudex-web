import { opencodeGoModels } from "./opencode-go-models.mjs";

// 默认供应商统一使用现有 Messages 运行时；新增服务在此登记连接与模型信息。
export const providerPresets = [
  {
    id: "deepseek",
    backendId: "claude",
    name: "DeepSeek",
    icon: "deepseek",
    usage: "deepseek-balance",
    protocol: "anthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    modelDirectory: {
      url: "https://api.deepseek.com/models",
      authentication: "bearer",
      format: "deepseek",
    },
    models: ["deepseek-flash", "deepseek-v4-pro"],
    modelAliases: {
      "deepseek-flash": "DeepSeek Flash",
      "deepseek-v4-pro": "DeepSeek V4 Pro",
    },
    // https://api-docs.deepseek.com/api/list-models/
    modelCapabilities: Object.fromEntries(
      ["deepseek-flash", "deepseek-v4-pro"].map((model) => [
        model,
        {
          contextWindow: 1048576,
          supportedEffortLevels: ["low", "high", "max"],
          supportsAdaptiveThinking: true,
          supportsFastMode: false,
        },
      ]),
    ),
  },
  {
    id: "opencode-go",
    backendId: "claude",
    name: "OpenCode Go",
    icon: "opencode",
    protocol: "anthropic",
    authentication: "bearer",
    usage: "opencode-go-usage",
    baseUrl: "https://opencode.ai/inference/go/anthropic",
    modelDirectory: {
      url: "https://opencode.ai/inference/go/v1/models",
      authentication: "bearer",
      format: "opencode",
    },
    models: opencodeGoModels.map(([id]) => id),
    modelAliases: Object.fromEntries(
      opencodeGoModels.map(([id, name]) => [id, name]),
    ),
    modelCapabilities: Object.fromEntries(
      opencodeGoModels.map(([id, , contextWindow, effort]) => [
        id,
        {
          contextWindow,
          supportedEffortLevels: effort ? effort.split(" ") : [],
          supportsAdaptiveThinking: Boolean(effort),
          supportsFastMode: false,
        },
      ]),
    ),
  },
];

export function configuredPreset(preset, saved) {
  return {
    ...preset,
    ...(Number.isFinite(saved?.catalogueUpdatedAt) && {
      models: saved.models,
      modelAliases: saved.modelAliases,
      modelCapabilities: saved.modelCapabilities,
      catalogueUpdatedAt: saved.catalogueUpdatedAt,
    }),
    apiKey: saved?.apiKey || "",
    hiddenModels: saved?.hiddenModels || [],
    preset: true,
    enabled: Boolean(saved?.apiKey?.trim()),
  };
}

export function configuredProviders(saved) {
  return [
    ...providerPresets.map((preset) =>
      configuredPreset(
        preset,
        saved.find((provider) => provider.id === preset.id),
      ),
    ),
    ...saved.filter(
      (provider) => !providerPresets.some((p) => p.id === provider.id),
    ),
  ];
}

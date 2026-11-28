import { randomUUID } from "node:crypto";
import {
  configuredPreset,
  configuredProviders,
  providerPresets,
} from "./provider-presets.mjs";
import {
  createPresetCatalogueReader,
  mergePresetCatalogue,
} from "./preset-model-catalogue.mjs";
import { validateProviderProtocol } from "./provider-protocol.mjs";

export function createProviders(configuration, { fetchModels, timeout } = {}) {
  const readCatalogue = createPresetCatalogueReader(fetchModels, timeout);
  const publicProvider = ({ apiKey, modelDirectory, ...provider }) => ({
    ...provider,
    protocol: provider.protocol || "messages",
    hasApiKey: Boolean(apiKey),
    canRefreshModels: Boolean(modelDirectory),
    hiddenModels: provider.hiddenModels || [],
  });
  async function list(backendId, { includeDisabled = false } = {}) {
    const providers = await configuration.readProviders();
    return configuredProviders(providers)
      .filter(
        (p) =>
          p.backendId === "claude" &&
          (!backendId || p.backendId === backendId) &&
          (includeDisabled || p.enabled !== false),
      )
      .map(publicProvider);
  }
  async function get(backendId, providerId) {
    const providers = configuredProviders(
      await configuration.readProviders(),
    ).filter((p) => p.backendId === backendId);
    if (providerId == null || providerId === "") return null;
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) throw new Error("供应商已移除，请重新选择");
    if (provider.enabled === false)
      throw new Error("供应商已停用，请填写 API Key 后重试");
    const {
      hiddenModels: _hiddenModels,
      modelDirectory: _modelDirectory,
      catalogueUpdatedAt: _catalogueUpdatedAt,
      ...runtimeProvider
    } = provider;
    return runtimeProvider;
  }
  async function saveStored(input) {
    const preset = providerPresets.find((p) => p.id === input.id);
    if (input.backendId !== "claude")
      throw new Error("供应商配置仅用于 Claude Code");
    validateProviderProtocol(input.protocol);
    if (preset)
      input = {
        ...preset,
        apiKey: input.apiKey,
        hiddenModels: input.hiddenModels,
      };
    const id = input.id || randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("供应商标识无效");
    const url = new URL(input.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("请填写有效的 API 地址");
    if (!input.name?.trim()) throw new Error("请填写供应商名称");
    const models = (input.models || []).map((m) =>
      typeof m === "string" ? m.trim() : m.id?.trim(),
    );
    if (
      !models.length ||
      models.some((m) => !m) ||
      new Set(models).size !== models.length
    )
      throw new Error("请填写不重复的模型标识");
    if (
      input.hiddenModels !== undefined &&
      (!Array.isArray(input.hiddenModels) ||
        input.hiddenModels.some(
          (model) => typeof model !== "string" || !model.trim(),
        ))
    )
      throw new Error("隐藏模型列表无效");
    const modelAliases = {};
    for (const [model, alias] of Object.entries(input.modelAliases || {})) {
      if (!models.includes(model) || typeof alias !== "string")
        throw new Error("模型显示别名无效");
      if (alias.trim()) modelAliases[model] = alias.trim();
    }
    const modelCapabilities = input.modelCapabilities || {};
    for (const [model, metadata] of Object.entries(modelCapabilities)) {
      if (
        !models.includes(model) ||
        !Array.isArray(metadata.supportedEffortLevels) ||
        metadata.supportedEffortLevels.some(
          (level) => !["low", "medium", "high", "xhigh", "max"].includes(level),
        ) ||
        (metadata.contextWindow !== undefined &&
          (!Number.isSafeInteger(metadata.contextWindow) ||
            metadata.contextWindow <= 0)) ||
        [metadata.supportsFastMode, metadata.supportsAdaptiveThinking].some(
          (value) => value !== undefined && typeof value !== "boolean",
        )
      )
        throw new Error("模型参数配置无效");
    }
    const saved = await configuration.update((data) => {
      const backend = data.backends.find((b) => b.id === input.backendId);
      if (!backend) throw new Error("后端不存在");
      const previous = data.providers.find((p) => p.id === id);
      if (previous && previous.backendId !== input.backendId)
        throw new Error("供应商所属后端不可更改");
      const apiKey =
        input.apiKey === undefined
          ? previous?.apiKey || ""
          : String(input.apiKey).trim();
      const hasCatalogue =
        preset && Number.isFinite(previous?.catalogueUpdatedAt);
      const provider = {
        id,
        backendId: backend.id,
        name: input.name.trim(),
        protocol: input.protocol ?? previous?.protocol ?? "messages",
        baseUrl: url.href.replace(/\/$/, ""),
        models: hasCatalogue ? previous.models : models,
        hiddenModels: [
          ...new Set(input.hiddenModels ?? previous?.hiddenModels ?? []),
        ],
        modelAliases: hasCatalogue
          ? previous.modelAliases
          : input.modelAliases === undefined
            ? Object.fromEntries(
                Object.entries(previous?.modelAliases || {}).filter(([model]) =>
                  models.includes(model),
                ),
              )
            : modelAliases,
        modelCapabilities: hasCatalogue
          ? previous.modelCapabilities
          : input.modelCapabilities === undefined
            ? Object.fromEntries(
                Object.entries(previous?.modelCapabilities || {}).filter(
                  ([model]) => models.includes(model),
                ),
              )
            : modelCapabilities,
        apiKey,
        ...(hasCatalogue && {
          catalogueUpdatedAt: previous.catalogueUpdatedAt,
        }),
        ...(preset && {
          keyRevision:
            apiKey === (previous?.apiKey || "")
              ? previous?.keyRevision || ""
              : randomUUID(),
        }),
      };
      return {
        ...data,
        providers: [...data.providers.filter((p) => p.id !== id), provider],
      };
    });
    return saved.providers.find((provider) => provider.id === id);
  }
  async function save(input) {
    await saveStored(input);
    return list(input.backendId);
  }
  async function refreshStored(preset, snapshot) {
    const directory = await readCatalogue(preset, snapshot.apiKey);
    const matchesKey = (provider) =>
      provider?.apiKey === snapshot.apiKey &&
      provider.keyRevision === snapshot.keyRevision;
    const { providers } = await configuration.update((data) => ({
      ...data,
      providers: data.providers.map((current) => {
        if (current.id !== preset.id || !matchesKey(current)) return current;
        const effective = configuredPreset(preset, current);
        const {
          models,
          modelAliases,
          modelCapabilities,
          hiddenModels,
          catalogueUpdatedAt,
        } = mergePresetCatalogue(effective, directory);
        return {
          ...current,
          models,
          modelAliases,
          modelCapabilities,
          hiddenModels,
          catalogueUpdatedAt,
        };
      }),
    }));
    const updated = providers.find((provider) => provider.id === preset.id);
    return matchesKey(updated)
      ? publicProvider(configuredPreset(preset, updated))
      : null;
  }
  async function refresh(input) {
    const preset = providerPresets.find((provider) => provider.id === input.id);
    if (!preset?.modelDirectory) throw new Error("此供应商使用手工模型目录");
    if (Object.keys(input).some((key) => key !== "id" && key !== "apiKey"))
      throw new Error("模型目录请求只接受供应商和 API Key");
    if (input.apiKey !== undefined && typeof input.apiKey !== "string")
      throw new Error("API Key 格式无效");
    const saved = (await configuration.readProviders()).find(
      ({ id }) => id === preset.id,
    );
    const preview = input.apiKey !== undefined;
    const apiKey = preview ? input.apiKey.trim() : saved?.apiKey;
    if (!apiKey) throw new Error("填写 API Key 后可刷新模型");
    if (preview) {
      const directory = await readCatalogue(preset, apiKey);
      return {
        provider: publicProvider(
          mergePresetCatalogue(configuredPreset(preset, saved), directory),
        ),
        preview,
      };
    }
    const provider = await refreshStored(preset, saved);
    if (!provider) throw new Error("API Key 已更新，请重新刷新模型");
    return { provider, preview };
  }
  async function saveAndRefresh(input) {
    const saved = await saveStored(input);
    const preset = providerPresets.find(({ id }) => id === saved.id);
    let catalogueError;
    if (preset?.modelDirectory && input.apiKey !== undefined && saved.apiKey) {
      try {
        await refreshStored(preset, saved);
      } catch (error) {
        catalogueError = error.message;
      }
    }
    return { providers: await list(input.backendId), catalogueError };
  }
  async function remove({ id }) {
    await configuration.update((data) => ({
      ...data,
      providers: data.providers.filter((p) => p.id !== id),
    }));
    return list();
  }
  function request(method, params) {
    if (method === "lan/providers/list")
      return list(params.backendId, {
        includeDisabled: params.includeDisabled === true,
      }).then((providers) => ({ providers }));
    if (method === "lan/providers/save") return saveAndRefresh(params);
    if (method === "lan/providers/remove")
      return remove(params).then((providers) => ({ providers }));
    if (method === "lan/providers/refresh") return refresh(params);
  }
  return { list, get, save, remove, request };
}

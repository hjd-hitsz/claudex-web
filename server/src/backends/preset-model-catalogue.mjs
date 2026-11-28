const supportedEfforts = new Set(["low", "medium", "high", "xhigh", "max"]);

function readRows(preset, payload) {
  const go = preset.modelDirectory.format === "opencode";
  if (
    payload?.object !== "list" ||
    !Array.isArray(payload.data) ||
    payload.data.some(
      (row) =>
        typeof row?.id !== "string" ||
        !/^[^\s\x00-\x1f\x7f]{1,256}$/u.test(row.id) ||
        (go && typeof row.type !== "string"),
    )
  )
    throw new Error(`${preset.name} 模型目录响应缺少可用的模型资料`);
  return payload.data.flatMap((row) => {
    const textModel = go
      ? row.type === "chat" && row.capabilities?.tools?.supported !== false
      : (row.type == null || row.type === "chat") &&
        (row.output_modalities == null ||
          row.output_modalities.includes("text")) &&
        (row.api_capabilities == null ||
          Boolean(row.api_capabilities.anthropic_messages));
    if (!textModel) return [];
    const contextWindow = go ? row.limit?.context : row.context_window;
    const efforts = go
      ? row.capabilities?.reasoning?.effort
      : row.effort?.supported_levels;
    const supportedEffortLevels = Array.isArray(efforts)
      ? [...new Set(efforts.filter((effort) => supportedEfforts.has(effort)))]
      : [];
    return [
      {
        id: row.id,
        name:
          typeof row.name === "string" && row.name.trim()
            ? row.name.trim()
            : row.id,
        capabilities: {
          ...(Number.isSafeInteger(contextWindow) &&
            contextWindow > 0 && { contextWindow }),
          supportedEffortLevels,
          supportsAdaptiveThinking: supportedEffortLevels.length > 0,
          supportsFastMode: false,
        },
      },
    ];
  });
}

export function mergePresetCatalogue(previous, { rows, updatedAt }) {
  const ids = new Set(rows.map(({ id }) => id));
  return {
    ...previous,
    models: [...ids],
    hiddenModels: (previous.hiddenModels || []).filter((id) => ids.has(id)),
    modelAliases: Object.fromEntries(
      rows.map(({ id, name }) => [
        id,
        Object.hasOwn(previous.modelAliases || {}, id)
          ? previous.modelAliases[id]
          : name,
      ]),
    ),
    modelCapabilities: Object.fromEntries(
      rows.map(({ id, capabilities }) => [
        id,
        Object.hasOwn(previous.modelCapabilities || {}, id)
          ? { ...capabilities, ...previous.modelCapabilities[id] }
          : capabilities,
      ]),
    ),
    catalogueUpdatedAt: updatedAt,
  };
}

export function createPresetCatalogueReader(
  fetchModels = fetch,
  timeout = 10000,
) {
  const pending = new Map();
  async function load(preset, apiKey) {
    const { url, authentication } = preset.modelDirectory;
    const signal = AbortSignal.timeout(timeout);
    let response;
    try {
      response = await fetchModels(url, {
        headers:
          authentication === "bearer"
            ? { Authorization: `Bearer ${apiKey}` }
            : {},
        redirect: "error",
        signal,
      });
    } catch {
      throw new Error(
        `${preset.name} 模型目录${signal.aborted ? "请求超时" : "网络请求失败"}`,
      );
    }
    if (response.status === 401)
      throw new Error(`${preset.name} 模型目录认证失败（HTTP 401）`);
    if (response.status === 403)
      throw new Error(`${preset.name} 当前凭据无权读取模型目录（HTTP 403）`);
    if (!response.ok)
      throw new Error(
        `${preset.name} 模型目录读取失败（HTTP ${response.status}）`,
      );
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(
        `${preset.name} 模型目录${signal.aborted ? "请求超时" : "响应格式无效"}`,
      );
    }
    return { rows: readRows(preset, payload), updatedAt: Date.now() };
  }
  return (preset, apiKey) => {
    const key = JSON.stringify([preset.id, apiKey]);
    if (!pending.has(key))
      pending.set(
        key,
        load(preset, apiKey).finally(() => pending.delete(key)),
      );
    return pending.get(key);
  };
}

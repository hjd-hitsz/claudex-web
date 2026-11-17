export async function validateSubagentSettings(backend, providers) {
  if (!backend.subagentProviderId || backend.subagentProviderId === "@native")
    return;
  const provider = await providers.get("claude", backend.subagentProviderId);
  if (!provider.models.includes(backend.subagentModel))
    throw new Error("子代理模型不在所选供应商的模型列表中");
  if (
    backend.subagentEffort &&
    !provider.modelCapabilities?.[
      backend.subagentModel
    ]?.supportedEffortLevels?.includes(backend.subagentEffort)
  )
    throw new Error("子代理模型不支持所选思考强度");
}

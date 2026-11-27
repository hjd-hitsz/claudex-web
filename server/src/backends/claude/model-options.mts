import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  ExecutionBackend,
  ExecutionProvider,
  QueuedExecution,
  SessionDependencies,
} from "./execution-types.d.mts";
import { nativeSubagentProvider } from "./native-provider.mjs";

export async function resolveSubagentProvider(
  backend: ExecutionBackend,
  providers: SessionDependencies["providers"],
  provider: ExecutionProvider | null | undefined,
) {
  const { subagentProviderId, subagentModel, subagentEffort } = backend;
  if (subagentProviderId === "@native")
    return provider || subagentEffort ? nativeSubagentProvider(backend) : null;
  if (!subagentProviderId) return null;
  const selected = await providers.get(backend.id, subagentProviderId);
  if (selected && !selected.models.includes(subagentModel || ""))
    throw new Error("子代理模型已从供应商移除，请重新配置");
  return selected;
}

export function modelOptions(
  provider: ExecutionProvider | null | undefined,
  model: string | undefined,
  input: Pick<QueuedExecution, "effort" | "serviceTier">,
): Pick<Options, "effort"> & { settings: { fastMode: boolean } } {
  const standard = provider && (provider.protocol || "messages") === "messages";
  const capabilities = (model && provider?.modelCapabilities?.[model]) || {};
  const effort = input.effort || undefined;
  const fastMode =
    input.serviceTier === "fast" || input.serviceTier === "priority";
  if (
    standard &&
    effort &&
    !capabilities.supportedEffortLevels?.includes(effort)
  )
    throw new Error("所选模型尚未配置此思考强度，请检查模型参数。");
  if (standard && fastMode && !capabilities.supportsFastMode)
    throw new Error("所选模型尚未配置快速模式，请检查模型参数。");
  return {
    ...(effort && { effort }),
    settings: { fastMode },
  };
}

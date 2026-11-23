import { join } from "node:path";
import { writePrivateFile } from "../../private-file.mjs";

export function createOpenCodeCatalogue({
  sdk,
  backend,
  providers,
  active,
  subscription,
}) {
  let configuration;
  const contexts = new Map();
  const plugin = {
    id: "claudex.catalogue",
    setup(ctx) {
      contexts.set(ctx.location.directory, ctx);
      return () => {
        if (contexts.get(ctx.location.directory) === ctx)
          contexts.delete(ctx.location.directory);
      };
    },
  };
  const file = join(backend.stateDir, "providers.json");
  async function sync() {
    const saved = await providers.list("opencode");
    const entries = await Promise.all(
      saved.map((p) => providers.get("opencode", p.id)),
    );
    const content = JSON.stringify({
      providers: Object.fromEntries(
        entries.map((p) => [
          `claudex-${p.id}`,
          {
            package: "@ai-sdk/anthropic",
            settings: {
              baseURL: p.baseUrl.endsWith("/v1")
                ? p.baseUrl
                : `${p.baseUrl}/v1`,
              apiKey: p.apiKey,
            },
            models: Object.fromEntries(
              p.models.map((id) => [
                id,
                {
                  name: p.modelAliases?.[id] || id,
                  ...(p.modelCapabilities?.[id]?.supportedEffortLevels
                    ?.length && {
                    capabilities: {
                      reasoning: {
                        supported: true,
                        toggle:
                          p.modelCapabilities[id].supportsAdaptiveThinking ===
                          true,
                        effort: p.modelCapabilities[id].supportedEffortLevels,
                      },
                    },
                  }),
                  ...(p.modelCapabilities?.[id]?.contextWindow && {
                    limit: { context: p.modelCapabilities[id].contextWindow },
                  }),
                },
              ]),
            ),
          },
        ]),
      ),
    });
    if (content === configuration) return;
    if (configuration && active.size)
      throw new Error("供应商配置已更新，请等待 OpenCode 当前任务结束后应用。");
    await writePrivateFile(file, content);
    if (sdk()) await sdk().location.reload();
    configuration = content;
  }
  async function models(cwd) {
    await sync();
    const authenticated = await subscription.sync();
    const [result, configured] = await Promise.all([
      sdk().model.list({ location: { directory: cwd }, types: ["chat"] }),
      providers.list("opencode"),
    ]);
    return result.data
      .filter(
        (model) =>
          model.enabled &&
          (model.providerID === "openai"
            ? Boolean(authenticated?.models.includes(model.id))
            : configured.some((p) => `claudex-${p.id}` === model.providerID)),
      )
      .map((model) => {
        const codex =
          model.providerID === "openai" &&
          authenticated?.modelCatalogue?.find(
            (entry) => entry.model === model.id,
          );
        return {
          id: `${model.providerID}/${model.id}`,
          model: `${model.providerID}/${model.id}`,
          displayName: model.name,
          providerName:
            model.providerID === "openai"
              ? "ChatGPT"
              : configured.find((p) => `claudex-${p.id}` === model.providerID)
                  ?.name || model.providerID,
          supportedReasoningEfforts:
            codex?.supportedReasoningEfforts ||
            model.variants.map((v) => ({
              reasoningEffort: v.id,
              description: v.name || v.id,
            })),
          defaultReasoningEffort: codex?.defaultReasoningEffort || "",
          ...(codex && {
            serviceTiers: codex.serviceTiers,
            additionalSpeedTiers: codex.additionalSpeedTiers,
            defaultServiceTier: codex.defaultServiceTier,
            isDefault: codex.isDefault,
          }),
          supportsImages:
            model.capabilities?.input?.includes?.("image") || false,
          contextWindow: model.limit.context,
        };
      });
  }
  async function request(method, p) {
    const location = { directory: p.cwd };
    if (method === "model/list")
      return { data: await models(p.cwd), nextCursor: null };
    if (method === "config/read") return { config: {} };
    if (method === "skills/list") {
      const [skills, commands, agents] = await Promise.all([
        sdk().skill.list({ location }),
        sdk().command.list({ location }),
        sdk().agent.list({ location }),
      ]);
      return {
        data: [
          {
            cwd: p.cwd,
            skills: skills.data.map((s) => ({
              path: s.path,
              description: s.description,
              name: s.id,
              displayName: s.name || s.id,
              native: true,
            })),
          },
        ],
        commands: commands.data,
        agents: agents.data,
      };
    }
    if (method === "plugin/installed") {
      const result = await sdk().plugin.list({ location });
      return {
        marketplaces: [
          {
            name: "OpenCode",
            plugins: result.data.map((p) => ({
              id: p.id || p.source.target || p.source.path,
              name: p.id || p.source.target || p.source.path || "OpenCode",
              enabled: p.state.status === "active",
              errors: p.state.error ? [p.state.error] : [],
            })),
          },
        ],
      };
    }
    if (method === "mcpServerStatus/list") {
      const result = await sdk().mcp.list({ location });
      const tools = await contexts.get(result.location.directory)?.tool.list();
      return {
        data: result.data.map((server) => ({
          name: server.name,
          status:
            server.status.status === "needs_auth"
              ? "needs-auth"
              : server.status.status,
          error: server.status.error,
          tools: Object.fromEntries(
            (tools || [])
              .filter(
                (t) =>
                  t.options?.namespace ===
                  server.name.replace(/[^a-zA-Z0-9_-]/g, "_"),
              )
              .map((t) => [
                t.name,
                { name: t.name, description: t.description },
              ]),
          ),
        })),
        nextCursor: null,
      };
    }
  }
  return { file, sync, models, request, plugin };
}

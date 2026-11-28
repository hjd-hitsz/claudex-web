import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { networkProxyEnvironment } from "../network-proxy.mjs";

export function subagentModelEnvironment(backend, proxy) {
  return {
    ...(backend.subagentModel && {
      CLAUDE_CODE_SUBAGENT_MODEL: proxy?.subagentModel || backend.subagentModel,
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
    }),
    ...(backend.subagentEffort && {
      CLAUDE_CODE_SUBAGENT_EFFORT: backend.subagentEffort,
    }),
  };
}

export function claudeRuntimeEnvironment(backend) {
  const env = {
    ...process.env,
    ...networkProxyEnvironment(backend.proxy),
    ...subagentModelEnvironment(backend),
  };
  const original = resolve(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
  if (resolve(backend.dataDir) !== original)
    env.CLAUDE_CONFIG_DIR = backend.dataDir;
  return env;
}

function modelCapabilityRules(metadataByModel) {
  return Object.entries(metadataByModel)
    .flatMap(([name, metadata]) => {
      const capabilities = [];
      if (typeof metadata.supportsAdaptiveThinking === "boolean")
        capabilities.push(
          metadata.supportsAdaptiveThinking
            ? "adaptive_thinking"
            : "-adaptive_thinking",
        );
      if (Array.isArray(metadata.supportedEffortLevels)) {
        capabilities.push(
          metadata.supportedEffortLevels.length ? "effort" : "-effort",
        );
        for (const level of ["xhigh", "max"])
          capabilities.push(
            `${metadata.supportedEffortLevels.includes(level) ? "" : "-"}${level}_effort`,
          );
      }
      return capabilities.length ? [`${name}=${capabilities.join(",")}`] : [];
    })
    .join(";");
}

export function providerModelEnvironment(provider, model, effort) {
  const selectedModel = model || provider.models[0];
  return {
    ANTHROPIC_MODEL: selectedModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: selectedModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedModel,
    CLAUDE_CODE_MODEL_CAPABILITIES: modelCapabilityRules(
      provider.modelCapabilities || {},
    ),
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(
      provider.modelCapabilities?.[selectedModel]?.contextWindow || "",
    ),
    ...((provider.protocol || "messages") === "messages" && {
      CLAUDE_CODE_EFFORT_LEVEL: effort || "unset",
    }),
  };
}

export function providerRuntimeEnvironment(
  provider,
  backend,
  { proxy, model, effort } = {},
) {
  const env = claudeRuntimeEnvironment(backend);
  delete env.CLAUDECODE;
  if (proxy) {
    env.ANTHROPIC_BASE_URL = proxy.url;
    env.ANTHROPIC_CUSTOM_HEADERS = [
      env.ANTHROPIC_CUSTOM_HEADERS,
      `x-claudex-proxy-token: ${proxy.token}`,
    ]
      .filter(Boolean)
      .join("\n");
    Object.assign(env, subagentModelEnvironment(backend, proxy));
  }
  if (!provider) {
    if (proxy?.subagentModel)
      env.CLAUDE_CODE_MODEL_CAPABILITIES = [
        env.CLAUDE_CODE_MODEL_CAPABILITIES,
        modelCapabilityRules(proxy.modelCapabilities),
      ]
        .filter(Boolean)
        .join(";");
    return env;
  }
  for (const key of [
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
    "CLAUDE_CODE_EFFORT_LEVEL",
  ])
    delete env[key];
  Object.assign(
    env,
    providerModelEnvironment(
      {
        ...provider,
        modelCapabilities: {
          ...provider.modelCapabilities,
          ...proxy?.modelCapabilities,
        },
      },
      model || provider.models[0],
      effort,
    ),
  );
  env.ANTHROPIC_BASE_URL = proxy?.url || provider.baseUrl;
  if (proxy || provider.authentication !== "bearer")
    env.ANTHROPIC_API_KEY = proxy?.token || provider.apiKey;
  else env.ANTHROPIC_AUTH_TOKEN = provider.apiKey;
  return env;
}

// 显式供应商通过 CLI 会话级设置覆盖生效，原生配置文件保持原样。
export function providerSettingsEnvironment(provider, backend, options) {
  const env = providerRuntimeEnvironment(provider, backend, options);
  return {
    CLAUDE_CODE_SUBAGENT_MODEL: "",
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "",
    CLAUDE_CODE_SUBAGENT_EFFORT: "",
    ...(provider && { ANTHROPIC_AUTH_TOKEN: "" }),
    ...(provider?.authentication === "bearer" && { ANTHROPIC_API_KEY: "" }),
    ...networkProxyEnvironment(backend.proxy),
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([key, value]) =>
          typeof value === "string" &&
          (key.startsWith("ANTHROPIC_") ||
            key.startsWith("CLAUDE_CODE_SUBAGENT_MODEL") ||
            key === "CLAUDE_CODE_SUBAGENT_EFFORT" ||
            [
              "CLAUDE_CODE_MODEL_CAPABILITIES",
              "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
              "CLAUDE_CODE_EFFORT_LEVEL",
            ].includes(key)),
      ),
    ),
  };
}

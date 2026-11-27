import { resolve, join } from "node:path";
import { createStorage } from "./storage.mjs";
import { validateNetworkProxy } from "./network-proxy.mjs";
import { subagentSettings } from "../../../shared/subagent-settings.mjs";

import { validateAgyBackend } from "./agy/configuration.mjs";

export function validateBackend(input, config) {
  if (input.id === "agy" && input.type === "agy")
    return validateAgyBackend(input, config);
  if (!["codex", "claude"].includes(input.id) || input.id !== input.type)
    throw new Error("未知的后端类型或标识");
  if (
    input.subagentModel !== undefined &&
    (typeof input.subagentModel !== "string" ||
      /[\s\x00-\x1f\x7f]/u.test(input.subagentModel.trim()) ||
      input.subagentModel.length > 256)
  )
    throw new Error("子代理模型须为不含空白的模型 ID，留空使用原生默认");
  if (
    input.subagentProviderId !== undefined &&
    (typeof input.subagentProviderId !== "string" ||
      (input.subagentProviderId !== "" &&
        input.subagentProviderId !== "@native" &&
        !/^[a-zA-Z0-9_-]{1,80}$/.test(input.subagentProviderId)))
  )
    throw new Error("子代理供应商标识无效");
  if (input.subagentProviderId && input.type !== "claude")
    throw new Error("子代理跨供应商配置仅用于 Claude Code");
  if (input.subagentProviderId && !input.subagentModel?.trim())
    throw new Error("选择子代理供应商后须指定模型");
  if (
    input.subagentEffort !== undefined &&
    ![
      "",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      ...(input.type === "codex" ? ["none", "minimal", "ultra"] : []),
    ].includes(input.subagentEffort)
  )
    throw new Error("子代理思考强度无效");
  if (
    input.backgroundTerminalEnabled !== undefined &&
    (input.type !== "codex" ||
      typeof input.backgroundTerminalEnabled !== "boolean")
  )
    throw new Error("后台终端 MCP 开关仅接受 Codex 的布尔设置");
  const backend = {
    id: input.id,
    name: input.type === "codex" ? "Codex" : "Claude Code",
    type: input.type,
    enabled: input.enabled !== false,
    subagentModel: input.subagentModel?.trim() || "",
    subagentEffort: input.subagentEffort || "",
    ...(input.type === "claude" && {
      subagentProviderId: input.subagentProviderId || "",
    }),
    dataDir: resolve(
      input.type === "codex" ? config.codexHome : config.claudeHome,
    ),
    ...(input.type === "claude" && {
      stateDir: join(config.configDir, "backends", "claude"),
      ...(input.proxy !== undefined && {
        proxy: validateNetworkProxy(input.proxy),
      }),
    }),
    executable: input.type === "claude" ? "claude" : "codex",
    args: [],
  };
  if (input.type === "codex") {
    const url = new URL(config.upstreamUrl);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password)
      throw new Error("请填写 WebSocket 服务地址");
    if (
      url.protocol === "ws:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw new Error("跨主机后端必须使用 WSS");
    backend.url = url.href;
    backend.backgroundTerminalEnabled =
      input.backgroundTerminalEnabled ?? Boolean(config.backgroundTaskDir);
  }
  if (
    input.hiddenModels !== undefined &&
    (!Array.isArray(input.hiddenModels) ||
      input.hiddenModels.some((id) => typeof id !== "string" || !id.trim()))
  )
    throw new Error("隐藏模型列表无效");
  backend.hiddenModels = [...new Set(input.hiddenModels || [])];
  return backend;
}

export function createBackendConfiguration(config) {
  const storage = createStorage(
    config.backendsFile || join(config.configDir, "backends.json"),
    {
      version: 1,
      backends: [
        {
          id: "codex",
          name: "Codex",
          type: "codex",
          enabled: true,
          url: config.upstreamUrl,
          dataDir: config.codexHome,
          executable: "codex",
          args: [],
        },
        {
          id: "claude",
          name: "Claude Code",
          type: "claude",
          enabled: false,
          dataDir: config.claudeHome,
          stateDir: join(config.configDir, "backends", "claude"),
          executable: "claude",
          args: [],
        },
      ],
      providers: [],
    },
  );
  async function save(input) {
    const previous = (await storage.read()).backends.find(
      (b) => b.id === input.id,
    );
    const backend = validateBackend({ ...previous, ...input }, config);
    await storage.update((data) => ({
      ...data,
      backends: [...data.backends.filter((b) => b.id !== backend.id), backend],
    }));
    return backend;
  }
  async function read() {
    const data = await storage.read();
    const ids = new Set();
    for (const backend of data.backends) {
      if (
        !["codex", "claude", "agy"].includes(backend.id) ||
        backend.type !== backend.id ||
        ids.has(backend.id)
      )
        throw new Error("配置中的后端类型或标识无效");
      ids.add(backend.id);
    }
    return {
      ...data,
      backends: ["codex", "claude", "agy"].map((id) =>
        validateBackend(
          {
            ...data.backends.find((b) => b.id === id),
            id,
            type: id,
            enabled: data.backends.find((b) => b.id === id)?.enabled ?? false,
          },
          config,
        ),
      ),
    };
  }
  return {
    ...storage,
    read,
    save,
    async readDelegationSettings() {
      const { backends } = await storage.read();
      return validateAgyBackend(
        backends.find(({ id }) => id === "agy") || {},
        config,
      );
    },
    async readSubagentSettings(id) {
      return subagentSettings(
        (await storage.read()).backends.find((b) => b.id === id) || {},
      );
    },
    async readProviders() {
      return (await storage.read()).providers;
    },
  };
}

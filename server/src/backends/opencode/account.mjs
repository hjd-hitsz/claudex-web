import {
  supportsProviderBalance,
  readProviderBalance,
} from "../provider-balance.mjs";

export function createOpenCodeAccount({ providers, subscription }) {
  async function request(method, p) {
    if (!method.startsWith("account/")) return;
    const providerID = p.model?.split("/")[0];
    const configured = providerID?.startsWith("claudex-")
      ? await providers.get("opencode", providerID.slice(8))
      : null;
    if (method === "account/read") {
      if (configured)
        return {
          account: {
            type: "provider",
            name: configured.name,
            providerName: configured.name,
            providerId: configured.id,
            usageSupported: supportsProviderBalance(configured),
          },
        };
      const current = await subscription.read();
      return {
        account: current
          ? {
              ...current.account,
              type: "chatgpt",
              name: current.account?.email || "ChatGPT",
              usageSupported: false,
            }
          : null,
      };
    }
    if (method === "account/rateLimits/read") {
      if (supportsProviderBalance(configured))
        return readProviderBalance(configured);
      return {
        rateLimits: null,
        availability: configured ? "external" : "unavailable",
      };
    }
    throw new Error("ChatGPT 账户由 Codex 后端管理。");
  }
  return { request };
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// 原生账户作为子代理目标时，每次请求读取 CLI 当前保存的认证。
export async function nativeProviderHeaders(backend) {
  const env = process.env;
  if (env.ANTHROPIC_AUTH_TOKEN)
    return { authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}` };
  if (env.ANTHROPIC_API_KEY) return { "x-api-key": env.ANTHROPIC_API_KEY };
  let token = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    try {
      const credentials = JSON.parse(
        await readFile(join(backend.dataDir, ".credentials.json"), "utf8"),
      );
      token = credentials.claudeAiOauth?.accessToken;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!token) throw new Error("Claude 原生账户认证不可用");
  return {
    authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
  };
}

export const nativeSubagentProvider = (backend) => ({
  id: "@native",
  native: true,
  dataDir: backend.dataDir,
  baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  protocol: "anthropic",
  modelCapabilities: {},
});

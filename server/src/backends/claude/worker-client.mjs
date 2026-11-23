import { fileURLToPath } from "node:url";
import { findCli } from "../cli-installation.mjs";
import { createWorkerAdapter } from "../worker/worker-client.mjs";
import { claudeCapabilities } from "../../../../shared/backend-capabilities.mjs";
export function createClaudeWorkerAdapter(options) {
  return createWorkerAdapter({
    ...options,
    capabilities: claudeCapabilities,
    entry: fileURLToPath(new URL("./worker-server.mjs", import.meta.url)),
    environmentKeys: [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_MODEL",
      "ANTHROPIC_CUSTOM_HEADERS",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_EFFORT_LEVEL",
      "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
    ],
    prepareBackend: async (backend) => ({
      ...backend,
      executable:
        backend.executable === "claude"
          ? await findCli("claude")
          : backend.executable,
    }),
  });
}

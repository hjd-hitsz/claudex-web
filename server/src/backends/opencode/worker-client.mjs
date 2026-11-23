import { fileURLToPath } from "node:url";
import { createWorkerAdapter } from "../worker/worker-client.mjs";
import { resolveOpenCode } from "./installation.mjs";
import { opencodeCapabilities } from "../../../../shared/backend-capabilities.mjs";
export function createOpenCodeWorkerAdapter(options) {
  return createWorkerAdapter({
    ...options,
    capabilities: opencodeCapabilities,
    entry: fileURLToPath(new URL("./worker-server.mjs", import.meta.url)),
    environmentKeys: [
      "XDG_DATA_HOME",
      "XDG_CONFIG_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_DB",
    ],
    prepareBackend: async (backend) => ({
      ...backend,
      sdkEntry: (await resolveOpenCode(options.config.configDir)).entry,
    }),
  });
}

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export async function loadOpenCode(entry, { workspaceTools = false } = {}) {
  if (workspaceTools)
    process.env.OPENCODE_FLAGS = [process.env.OPENCODE_FLAGS, "-full_codemode"]
      .filter(Boolean)
      .join(",");
  const url = entry.startsWith("file:") ? entry : pathToFileURL(entry).href;
  const sdk = await import(url);
  // The SDK's Undici has its own dispatcher and replaces Node's environment
  // proxy dispatcher on import. Configure that dispatcher before any requests.
  const { Agent, EnvHttpProxyAgent, setGlobalDispatcher } =
    createRequire(url)("undici");
  setGlobalDispatcher(
    process.env.NODE_USE_ENV_PROXY === "0"
      ? new Agent()
      : new EnvHttpProxyAgent(),
  );
  return sdk.OpenCode;
}

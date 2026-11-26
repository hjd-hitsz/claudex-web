import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const root = new URL("../../prompt/", import.meta.url).href;

// Node tests read the same Markdown text that Vite exposes via ?raw.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(root) || !url.endsWith(".md?raw"))
      return nextLoad(url, context);
    const content = readFileSync(new URL(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(content)};`,
    };
  },
});

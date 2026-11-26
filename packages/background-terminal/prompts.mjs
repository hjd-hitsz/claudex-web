import { existsSync, readFileSync } from "node:fs";

const bundled = new URL(
  "../../prompt/background-terminal/tasks.md",
  import.meta.url,
);
const inProduct = existsSync(bundled);
const source = inProduct
  ? bundled
  : new URL("./prompt/tasks.md", import.meta.url);
const { promptSections } = inProduct
  ? await import("../../shared/prompt-sections.mjs")
  : await import(new URL("./prompt-sections.generated.mjs", import.meta.url));

export const taskPrompt = promptSections(
  readFileSync(source, "utf8"),
  "background-terminal/tasks.md",
);

import { realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export async function secretaryProjectParams(params, cwd) {
  if (!isAbsolute(cwd)) throw new Error("Codex 秘书会话需要绝对工作目录。");
  // Codex checks each .codex layer's directory against session trust overrides.
  // Include the canonical path because the native loader resolves symlinks.
  const projects = new Map();
  const canonical = await realpath(cwd).catch((error) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return cwd;
    throw error;
  });
  for (let directory of new Set([cwd, canonical])) {
    while (true) {
      projects.set(directory, { trust_level: "untrusted" });
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return {
    ...params,
    cwd,
    config: {
      ...params.config,
      project_doc_max_bytes: 0,
      projects: Object.fromEntries(projects),
    },
  };
}

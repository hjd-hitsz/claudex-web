import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { resourceId } from "../../../../shared/backend-identity.mjs";

export function createDelegatedThreadIndex(configDirectory) {
  const path = join(configDirectory, "backends", "agy", "state.json");
  let revision;
  let ids = new Set();
  return async function hideDelegatedThreads(page) {
    let file;
    try {
      file = await stat(path, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT") return page;
      throw error;
    }
    const next = `${file.ino}:${file.mtimeNs}`;
    if (revision !== next) {
      const { tasks } = JSON.parse(await readFile(path, "utf8"));
      ids = new Set(
        Object.values(tasks || {})
          .filter(({ executor }) => executor?.threadId)
          .map(({ target, executor }) => resourceId(target, executor.threadId)),
      );
      revision = next;
    }
    return { ...page, data: page.data.filter(({ id }) => !ids.has(id)) };
  };
}

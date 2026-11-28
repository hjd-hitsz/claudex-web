import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const delegationRecordsPath = (directory) =>
  join(directory, "delegation-records.json");

function threadKey(threadId) {
  // Codex ThreadId accepts standard UUID spellings and serializes hyphenated lowercase.
  const uuid = threadId.replace(/^urn:uuid:|[-{}]/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(uuid) ? uuid : threadId;
}

export function indexExecutorThreads(path, identify) {
  let revision;
  let ids = new Set();
  return async () => {
    let file;
    try {
      file = await stat(path, { bigint: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      revision = undefined;
      return new Set();
    }
    const next = `${file.dev}:${file.ino}:${file.mtimeNs}`;
    if (revision !== next) {
      const { tasks } = JSON.parse(await readFile(path, "utf8"));
      ids = new Set(
        Object.values(tasks || {})
          .map(identify)
          .filter(Boolean),
      );
      revision = next;
    }
    return ids;
  };
}

export function createResearchThreadLookup({ paths, runtimeId }) {
  const readers = paths.map((path) =>
    indexExecutorThreads(path, ({ target, scope, executor }) =>
      target === "codex" &&
      scope === "research" &&
      executor?.runtimeId === runtimeId &&
      typeof executor?.threadId === "string"
        ? threadKey(executor.threadId)
        : undefined,
    ),
  );
  return async (threadId) => {
    if (typeof threadId !== "string" || !threadId) return false;
    const results = await Promise.all(readers.map((read) => read()));
    return results.some((ids) => ids.has(threadKey(threadId)));
  };
}

export function createBackgroundResearchLookup(directory) {
  let binding;
  let isResearchThread;
  return async (threadId) => {
    const current = await readFile(
      delegationRecordsPath(directory),
      "utf8",
    ).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!current) return false;
    if (binding !== current) {
      isResearchThread = createResearchThreadLookup(JSON.parse(current));
      binding = current;
    }
    return isResearchThread(threadId);
  };
}

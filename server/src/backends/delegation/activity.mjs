import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { resourceId } from "../../../../shared/backend-identity.mjs";
import { agyStateDirectory } from "../agy/configuration.mjs";
import { agySessionStatePath } from "../agy/session-store.mjs";
import { currentResultNotice, executing } from "./delegation-store.mjs";

export const nativeDelegationStatePath = (configDir) =>
  join(configDir, "delegation", "state.json");

function readIndex(path, agy) {
  let revision;
  let indexed;
  return async () => {
    let info;
    try {
      info = await stat(path, { bigint: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      revision = undefined;
      return [];
    }
    const next = [info.dev, info.ino, info.mtimeNs].join(":");
    if (next !== revision) {
      const state = JSON.parse(await readFile(path, "utf8"));
      const pending = new Set(
        Object.values(state.notices)
          .filter(
            (notice) =>
              ["queued", "submitting"].includes(notice.status) &&
              currentResultNotice(state, notice),
          )
          .map((notice) => notice.taskId),
      );
      const parents = new Map();
      for (const task of Object.values(state.tasks)) {
        if (!executing.has(task.status) && !pending.has(task.id)) continue;
        const { parentId, sourceRuntime } = task;
        const parent = agy && state.sessions[parentId];
        if (agy && (!parent || parent.archived || parent.deleted)) continue;
        const threadId = agy ? resourceId("agy", parentId) : parentId;
        parents.set(JSON.stringify([threadId, sourceRuntime]), {
          threadId,
          sourceRuntime,
        });
      }
      indexed = [...parents.values()];
      revision = next;
    }
    return indexed;
  };
}

export function createDelegationActivity(configDir, agyEnabled) {
  const native = readIndex(nativeDelegationStatePath(configDir), false);
  const agy = readIndex(
    agySessionStatePath(agyStateDirectory(configDir)),
    true,
  );
  return async () =>
    (await Promise.all([native(), agyEnabled() ? agy() : []])).flat();
}

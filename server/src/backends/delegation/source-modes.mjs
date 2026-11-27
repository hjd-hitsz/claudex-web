import { join } from "node:path";
import { runtimeIdentity } from "../../conversation-manager/address.mjs";
import { createStorage } from "../storage.mjs";

export function createDelegationModes(configDir) {
  const store = createStorage(join(configDir, "delegation", "modes.json"), {});
  const key = (backend, threadId) =>
    JSON.stringify([runtimeIdentity(backend), threadId]);
  return {
    async enabled(backend, threadId) {
      return (await store.read())[key(backend, threadId)] === true;
    },
    async save(backend, threadId, enabled) {
      const id = key(backend, threadId);
      await store.update((modes) => {
        modes[id] = enabled;
        return modes;
      });
    },
  };
}

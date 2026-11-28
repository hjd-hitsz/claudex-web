import { runtimeIdentity } from "../../conversation-manager/address.mjs";
import { createStorage } from "../storage.mjs";
import {
  codexSecretaryStatus,
  secretaryHistoryVersion,
  secretaryUpgradeRequired,
} from "../../../../packages/background-terminal/secretary-history-policy.mjs";
import { isSecretarySession } from "./session-role.mjs";

import {
  delegationModesPath,
  delegationModeKey as key,
} from "./mode-storage.mjs";

export { delegationModesPath };

export function createDelegationModes(configDir) {
  const path = delegationModesPath(configDir);
  const store = createStorage(path, {});
  const status = async (backend, threadId) =>
    codexSecretaryStatus(
      await store.read(),
      path,
      runtimeIdentity(backend),
      threadId,
    );
  return {
    async enabled(backend, threadId) {
      return isSecretarySession(
        backend.id,
        (await store.read())[key(backend, threadId)],
      );
    },
    status,
    async codexEnabledForResume(backend, threadId) {
      const mode = await status(backend, threadId);
      if (mode === "upgrade") throw new Error(secretaryUpgradeRequired);
      return mode === "secretary";
    },
    async save(backend, threadId, enabled, cleanHistory = false) {
      const id = key(backend, threadId);
      await store.update((modes) => {
        modes[id] = enabled;
        if (enabled && cleanHistory) {
          modes.secretaryHistory ||= {};
          modes.secretaryHistory[id] = secretaryHistoryVersion;
        } else if (modes.secretaryHistory) delete modes.secretaryHistory[id];
        return modes;
      });
    },
  };
}

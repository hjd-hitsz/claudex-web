import { join } from "node:path";
import { runtimeIdentity } from "../../conversation-manager/address.mjs";
import { createStorage } from "../storage.mjs";
import { isSecretarySession } from "./session-role.mjs";

export const delegationModesPath = (configDir) =>
  join(configDir, "delegation", "modes.json");

export function createDelegationModeReader(configDir) {
  const store = createStorage(delegationModesPath(configDir), {});
  return async (backend, threadId) =>
    isSecretarySession(
      backend.id,
      (await store.read())[delegationModeKey(backend, threadId)],
    );
}

export const delegationModeKey = (backend, threadId) =>
  JSON.stringify([runtimeIdentity(backend), threadId]);

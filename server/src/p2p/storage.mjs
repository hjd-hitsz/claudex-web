import { readFile } from "node:fs/promises";
import { writePrivateFile } from "../private-file.mjs";

export async function readPrivateJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  }
}

export function writePrivateJson(file, data) {
  return writePrivateFile(file, JSON.stringify(data, null, 2) + "\n");
}

export async function tunnelStorage(file, api, profile) {
  let state = (await readPrivateJson(file)) ?? { api };
  if (state.api !== api)
    throw new Error("OpenTunnel 服务地址与现有隧道身份不匹配");

  async function update(next) {
    await writePrivateJson(file, next);
    state = next;
  }

  function identity() {
    return (
      state.identity && {
        ...state.identity,
        certificateExpiry: new Date(state.identity.certificateExpiry),
      }
    );
  }

  return {
    profiles: async () => (state.identity || state.pending ? [profile] : []),
    load: async () => identity(),
    save: (_, value) => update({ api, identity: value }),
    loadPending: async () => state.pending,
    savePending: (_, pending) => update({ ...state, pending }),
    remove: () => update({ api }),
    list: async () => (state.identity ? [{ profile, tunnel: identity() }] : []),
  };
}

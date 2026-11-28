import { readFile } from "node:fs/promises";
import { writePrivateFile } from "../private-file.mjs";

export function createStorage(path, initial, { migrate } = {}) {
  let writing = Promise.resolve();
  async function read() {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(initial);
      throw error;
    }
  }
  function serialize(action) {
    const operation = writing.then(action);
    writing = operation.catch(() => {});
    return operation;
  }
  function write(data) {
    return writePrivateFile(path, JSON.stringify(data, null, 2) + "\n");
  }
  function update(change, readCurrent = true) {
    return serialize(async () => {
      const current = readCurrent ? await read() : undefined;
      const next = await change(
        readCurrent && migrate ? migrate(current) : current,
      );
      await write(next);
      return next;
    });
  }
  return {
    read: () =>
      migrate
        ? serialize(async () => {
            const current = await read();
            const next = migrate(current);
            if (next !== current) await write(next);
            return next;
          })
        : writing.then(read),
    update,
    replace: (value) => update(() => value, false),
  };
}

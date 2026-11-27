import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory, taskRequest } from "./client.mjs";

export function createBackgroundOwnerReader(location, expectedUpstream) {
  const inspected = new Set();
  const owners = new Map();
  let previous;

  return async function readRunningOwners() {
    const directory = await privateDirectory(location);
    const entry = await stat(directory, { bigint: true });
    const revision = [entry.ino, entry.mtimeNs].join(":");
    if (previous !== revision) {
      if (!previous?.startsWith(entry.ino + ":")) {
        inspected.clear();
        owners.clear();
      }
      const files = (await readdir(directory)).filter(
        (name) =>
          /^job-[a-f0-9-]{36}\.json$/.test(name) && !inspected.has(name),
      );
      for (let offset = 0; offset < files.length; offset += 50)
        await Promise.all(
          files.slice(offset, offset + 50).map(async (name) => {
            // The journal identifies owners, including unloaded threads. The
            // worker confirms each owner's current execution state.
            const record = JSON.parse(
              await readFile(join(directory, name), "utf8"),
            );
            if (record.status === "running") {
              const ids = owners.get(record.threadId) ?? new Set();
              ids.add(record.id);
              owners.set(record.threadId, ids);
            }
            inspected.add(name);
          }),
        );
      previous = revision;
    }
    const results = await Promise.allSettled(
      [...owners].map(async ([threadId, ids]) => {
        const { jobs } = await taskRequest(directory, "tool", {
          name: "background_list",
          args: {},
          threadId,
          expectedUpstream,
        });
        if (jobs.some((job) => job.status === "running")) return threadId;
        const known = new Set(jobs.map((job) => job.id));
        if ([...ids].every((id) => known.has(id))) owners.delete(threadId);
      }),
    );
    return {
      running: results.flatMap((result) =>
        result.status === "fulfilled" && result.value ? [result.value] : [],
      ),
      complete: results.every((result) => result.status === "fulfilled"),
    };
  };
}

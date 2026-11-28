import { join } from "node:path";
import { resourceId } from "../../../../shared/backend-identity.mjs";
import { indexExecutorThreads } from "../../../../packages/background-terminal/delegation-records.mjs";

export const delegationStatePaths = (configDirectory) => [
  join(configDirectory, "backends", "agy", "state.json"),
  join(configDirectory, "delegation", "state.json"),
];

export function createDelegatedThreadIndex(configDirectory) {
  const readers = delegationStatePaths(configDirectory).map((path) =>
    indexExecutorThreads(path, ({ target, executor }) =>
      resourceId(target, executor?.threadId),
    ),
  );
  return async (page) => {
    const ids = await Promise.all(readers.map((read) => read()));
    return {
      ...page,
      data: page.data.filter(({ id }) => !ids.some((set) => set.has(id))),
    };
  };
}

import {
  mcpConfig,
  taskRequest,
} from "../../../../packages/background-terminal/client.mjs";
import { threadMethods } from "./methods.mjs";

const prefix = "claudex-background:";
export const terminalMethods = new Set([
  "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/clean",
]);

export function backgroundParams(method, params, directory, upstream) {
  if (!directory || !threadMethods.has(method)) return params;
  return {
    ...params,
    config: { ...params.config, ...mcpConfig(directory, upstream) },
  };
}

export function backgroundTerminals(
  directory,
  upstream,
  nativeCall,
  request = taskRequest,
) {
  return async (method, params) => {
    const tool = (name, args = {}) =>
      request(directory, "tool", {
        name,
        args,
        threadId: params.threadId,
        expectedUpstream: new URL(upstream).href,
      });
    const running = async () =>
      (await tool("background_list")).jobs.filter(
        (job) => job.status === "running",
      );
    if (method.endsWith("/clean")) {
      const cancel = async () => {
        const results = await Promise.allSettled(
          (await running()).map((job) =>
            tool("background_cancel", { job_id: job.id }),
          ),
        );
        for (const result of results)
          if (result.status === "rejected") throw result.reason;
      };
      const [native, extension] = await Promise.allSettled([
        nativeCall(method, params),
        cancel(),
      ]);
      if (native.status === "rejected") throw native.reason;
      if (extension.status === "rejected") throw extension.reason;
      return native.value;
    }
    // Native pages retain their own cursors. Extension pages use UUID order and
    // a value cursor so stopping a job between pages cannot skip its neighbour.
    const extensionPage = params.cursor?.startsWith(prefix);
    const native = extensionPage
      ? { data: [], nextCursor: null }
      : await nativeCall(method, params);
    if (native.nextCursor) return native;
    const cursor = extensionPage ? params.cursor.slice(prefix.length) : "";
    const jobs = (await running())
      .filter((job) => job.id > cursor)
      .sort((a, b) => a.id.localeCompare(b.id));
    const room = Math.max(0, (params.limit || 100) - native.data.length);
    const selected = jobs.slice(0, room);
    return {
      data: [
        ...native.data,
        ...selected.map((job) => ({
          itemId: job.id,
          processId: job.id,
          command: job.command,
          cwd: job.cwd,
        })),
      ],
      nextCursor:
        jobs.length > room ? prefix + (selected.at(-1)?.id ?? cursor) : null,
    };
  };
}

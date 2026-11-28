import { connectCodex } from "./codex.mjs";
import { backgroundResumeParams } from "./thread-policy.mjs";

const key = (turnId, itemId) => JSON.stringify([turnId, itemId]);

export function createNativeWatches(
  url,
  jobs,
  connect = connectCodex,
  isResearchThread = async () => false,
  resumeThread = (call, params) => call("thread/resume", params),
) {
  const threads = new Map();
  let closing = false;

  function release(entry) {
    if (threads.get(entry.threadId) !== entry) return;
    threads.delete(entry.threadId);
    entry.connection?.close();
  }

  function enqueue(entry, operation) {
    entry.inFlight++;
    const work = entry.queue.then(operation).finally(() => {
      entry.inFlight--;
      if (!entry.inFlight && !entry.items.size) release(entry);
    });
    entry.queue = work.catch(() => {});
    return work;
  }

  async function finish(entry, itemKey, job, item) {
    await jobs.finishNative(entry.threadId, job.id, item);
    entry.items.delete(itemKey);
  }

  function observe(entry, { method, params }) {
    if (params?.threadId !== entry.threadId) return;
    if (
      method !== "item/completed" &&
      method !== "item/commandExecution/outputDelta"
    )
      return;
    const itemKey = key(params.turnId, params.item?.id ?? params.itemId);
    return enqueue(entry, async () => {
      const job = entry.items.get(itemKey);
      if (!job) return;
      if (method === "item/commandExecution/outputDelta") {
        await jobs.appendNative(entry.threadId, job.id, params.delta);
      } else if (
        params.item.type === "commandExecution" &&
        params.item.processId === job.native.processId
      ) {
        await finish(entry, itemKey, job, params.item);
      }
    }).catch((error) =>
      console.error("记录 Codex 原生终端事件", entry.threadId, error.message),
    );
  }

  function interrupt(entry, suppress = false) {
    return enqueue(entry, async () => {
      if (suppress && entry.items.size)
        await jobs.suppressThread(entry.threadId);
      for (const [itemKey, job] of entry.items) {
        await finish(entry, itemKey, job, { status: "interrupted" });
      }
    }).catch((error) =>
      console.error("结算 Codex 原生终端连接", entry.threadId, error.message),
    );
  }

  function open(threadId) {
    const entry = {
      threadId,
      items: new Map(),
      queue: Promise.resolve(),
      inFlight: 0,
    };
    threads.set(threadId, entry);
    entry.ready = connect(url, {
      event(message) {
        if (message.params?.threadId !== threadId) return;
        if (
          ["thread/closed", "thread/deleted", "thread/archived"].includes(
            message.method,
          )
        )
          return interrupt(entry, message.method !== "thread/closed");
        return observe(entry, message);
      },
      disconnected() {
        if (threads.get(threadId) === entry) interrupt(entry);
      },
    }).then(async (connection) => {
      entry.connection = connection;
      const research = await isResearchThread(threadId);
      const { thread } = await resumeThread(
        connection.call,
        backgroundResumeParams(threadId, research),
        { research },
      );
      if (thread.ephemeral || thread.path?.includes("/archived_sessions/"))
        throw new Error("原生后台终端需要未归档的持久对话");
      return connection;
    });
    return entry;
  }

  return {
    watch({ threadId, turnId, items }) {
      if (
        closing ||
        typeof threadId !== "string" ||
        !threadId ||
        typeof turnId !== "string" ||
        !turnId ||
        !Array.isArray(items) ||
        !items.length ||
        items.some(
          (item) =>
            !item ||
            typeof item.id !== "string" ||
            typeof item.processId !== "string" ||
            typeof item.command !== "string" ||
            typeof item.cwd !== "string",
        )
      )
        throw new Error("原生后台终端订阅参数无效");
      const entry = threads.get(threadId) ?? open(threadId);
      return enqueue(entry, async () => {
        const connection = await entry.ready;
        for (const item of items) {
          const itemKey = key(turnId, item.id);
          if (entry.items.has(itemKey)) continue;
          const job = await jobs.registerNative(threadId, turnId, item);
          if (job.status === "running") entry.items.set(itemKey, job);
        }
        // A command can finish while the independent connection is subscribing.
        const ids = items.map((item) => item.id);
        for (let i = 0; i < ids.length; i += 100) {
          const { data } = await connection.call("thread/items/read", {
            threadId,
            turnId,
            itemIds: ids.slice(i, i + 100),
          });
          for (const { item } of data) {
            const itemKey = key(turnId, item.id);
            const job = entry.items.get(itemKey);
            if (
              job &&
              item.type === "commandExecution" &&
              item.processId === job.native.processId &&
              item.status !== "inProgress"
            )
              await finish(entry, itemKey, job, item);
          }
        }
        return {};
      });
    },
    async close() {
      closing = true;
      const entries = [...threads.values()];
      await Promise.all(entries.map((entry) => interrupt(entry)));
      for (const entry of entries) release(entry);
    },
  };
}

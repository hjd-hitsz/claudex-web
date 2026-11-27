import {
  resourceId,
  resourceTarget,
} from "../../../shared/backend-identity.mjs";

function projectConversationActivity(thread) {
  const observed = thread.status ?? "unknown";
  const background = thread.background ?? observed === "background";
  const generating = thread.generating ?? observed === "running";
  const status =
    background && ["idle", "unknown"].includes(observed)
      ? "background"
      : observed;
  return {
    ...thread,
    status,
    background,
    generating,
    live: status !== "idle" && status !== "unknown",
  };
}

export function createConversationActivity() {
  const pending = new WeakMap();
  return async function observe(entry) {
    const adapter = entry.getAdapter();
    if (!adapter) return { threads: [], complete: false };
    let observation = pending.get(adapter);
    if (!observation) {
      observation = Promise.resolve()
        .then(() => adapter.observeThreads())
        .then(({ threads, complete }) => ({
          threads: threads.map(projectConversationActivity),
          complete,
        }))
        .finally(() => pending.delete(adapter));
      pending.set(adapter, observation);
    }
    const result = await observation;
    return entry.getAdapter() === adapter
      ? result
      : { threads: [], complete: false };
  };
}

function webConversationActivities(results, activeTurns) {
  const threads = new Map();
  for (const [backendId, result] of results)
    for (const record of result.threads) {
      const threadId = resourceId(backendId, record.threadId);
      const { status, generating, background, live } = record;
      if (live || status === "unknown")
        threads.set(threadId, {
          threadId,
          status,
          generating,
          background,
          live,
        });
    }
  for (const [threadId, turnId] of Object.entries(activeTurns)) {
    const activity = threads.get(threadId);
    if (activity?.live && activity.status !== "background")
      activity.turnId = turnId;
    else {
      const { status, live, generating, background } =
        projectConversationActivity({
          status: "running",
          background: activity?.background,
        });
      threads.set(threadId, {
        threadId,
        status,
        live,
        generating,
        background,
        turnId,
      });
    }
  }
  return [...threads.values()].sort((a, b) =>
    a.threadId.localeCompare(b.threadId),
  );
}

export async function listConversationActivities(
  backends,
  observe,
  readActiveTurns,
) {
  const entries = [...backends].filter(([, entry]) => entry.enabled);
  const observed = await Promise.allSettled(
    entries.map(([, entry]) => observe(entry)),
  );
  const results = observed.flatMap((result, index) => {
    const [runtimeId, entry] = entries[index];
    return result.status === "fulfilled" && backends.get(runtimeId) === entry
      ? [[entry.backendId, result.value]]
      : [];
  });
  return {
    activities: webConversationActivities(results, readActiveTurns()),
    complete:
      results.length === entries.length &&
      results.every(([, result]) => result.complete),
  };
}

export function conversationLifecycle(message, wake, wakeThread) {
  if (message.method === "lan/state") return wake();
  if (
    [
      "turn/started",
      "turn/completed",
      "thread/status/changed",
      "thread/backgroundTerminals/updated",
      "thread/closed",
      "thread/deleted",
      "thread/archived",
      "serverRequest/resolved",
      "lan/compaction",
    ].includes(message.method)
  ) {
    const { backendId, nativeId } = resourceTarget(
      message.params?.threadId,
      message.backendId,
    );
    if (nativeId) wakeThread(backendId, nativeId);
  }
}

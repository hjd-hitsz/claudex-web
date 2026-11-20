export function createSubscriptions({
  transport,
  compactions,
  activeTurns,
  activeThreads,
  backgroundHandoffPending = () => false,
}) {
  const subscriptions = new Map(),
    releasing = new Map(),
    resuming = new Map(),
    retained = new Map();
  const unwrittenThreads = new Set();
  const activeGoals = new Set();
  function updateGoal(threadId, goal) {
    if (goal?.status === "active") activeGoals.add(threadId);
    else activeGoals.delete(threadId);
  }
  async function resumeForWrite(
    threadId,
    { cwd, inheritPermissions = false } = {},
  ) {
    if (subscriptions.has(threadId)) return;
    if (!resuming.has(threadId)) {
      const resume = transport
        .call("thread/resume", {
          threadId,
          ...(cwd && { cwd }),
          excludeTurns: true,
          ...(!inheritPermissions && {
            approvalPolicy: "never",
            sandbox: "danger-full-access",
          }),
          config: { thread_unload_delay_secs: 0 },
        })
        .then(({ thread }) => {
          if (!subscriptions.has(thread.id))
            subscriptions.set(thread.id, new Set());
          if (thread.status?.type === "active") activeThreads.add(thread.id);
        })
        .finally(() => resuming.delete(threadId));
      resuming.set(threadId, resume);
    }
    await resuming.get(threadId);
  }
  function releaseUnusedThreads() {
    for (const [threadId, owners] of subscriptions) {
      if (
        !transport.ready ||
        compactions.busy(threadId) ||
        activeGoals.has(threadId) ||
        (unwrittenThreads.has(threadId) && owners.size) ||
        activeTurns.has(threadId) ||
        activeThreads.has(threadId) ||
        backgroundHandoffPending(threadId) ||
        retained.has(threadId) ||
        resuming.has(threadId) ||
        releasing.has(threadId) ||
        [...transport.pending.values()].some(
          (request) => request.threadId === threadId,
        )
      )
        continue;
      // 原生确认仅释放本连接；其他订阅者仍可持有会话。
      const release = transport
        .call(
          "thread/unsubscribe",
          { threadId },
          { trackThread: false, timeoutMessage: "取消对话订阅超时" },
        )
        .then((result) => {
          if (subscriptions.get(threadId) === owners) {
            subscriptions.delete(threadId);
            unwrittenThreads.delete(threadId);
          }
          return result;
        })
        .catch((error) => {
          console.error("Thread unsubscribe:", error.message);
          throw error;
        })
        .finally(() => {
          if (releasing.get(threadId) === release) releasing.delete(threadId);
        });
      release.catch(() => {});
      releasing.set(threadId, release);
    }
  }
  return {
    subscriptions,
    releasing,
    resuming,
    unwrittenThreads,
    updateGoal,
    resumeForWrite,
    releaseUnusedThreads,
    retainThread(threadId) {
      if (!retained.has(threadId)) retained.set(threadId, new Set());
      const leases = retained.get(threadId);
      const lease = Symbol();
      leases.add(lease);
      return () => {
        leases.delete(lease);
        if (!leases.size && retained.get(threadId) === leases)
          retained.delete(threadId);
        releaseUnusedThreads();
      };
    },
    releaseClient(client) {
      for (const owners of subscriptions.values()) owners.delete(client);
      releaseUnusedThreads();
    },
    reset() {
      subscriptions.clear();
      releasing.clear();
      resuming.clear();
      retained.clear();
      unwrittenThreads.clear();
      activeGoals.clear();
    },
  };
}

import { CodexRpcError } from "./upstream.mjs";

export async function observeCodexWork(transport, threadId) {
  const options = { trackThread: false };
  const results = await Promise.allSettled([
    transport.call("thread/goal/get", { threadId }, options),
    transport.call("thread/queue/list", { threadId, limit: 1 }, options),
  ]);
  const [goal, queue] = results;
  const activities = [];
  if (goal.status === "fulfilled" && goal.value.goal?.status === "active")
    activities.push("goal");
  if (queue.status === "fulfilled" && queue.value.data.length)
    activities.push("queued");
  return {
    activities,
    // With a valid thread ID and no cursor, the native processors use these
    // codes for unavailable operations or a thread that has since closed.
    complete: results.every(
      (result) =>
        result.status === "fulfilled" ||
        (result.reason instanceof CodexRpcError &&
          [-32600, -32601].includes(result.reason.code)),
    ),
  };
}

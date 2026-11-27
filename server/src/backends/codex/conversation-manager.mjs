import {
  formatConversationMessage,
  matchesConversationMessage,
} from "../../conversation-manager/message.mjs";
import { codexConversationMcpName } from "./conversation-tools.mjs";
import { CodexRpcError } from "./upstream.mjs";

const threadIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const notificationName = "thread_chat_message";

function conversationIdentity(thread) {
  return {
    threadId: thread.id,
    title: thread.name || thread.preview || "",
    cwd: thread.cwd,
    ...(thread.projectId && { projectId: thread.projectId }),
  };
}

function activity(status) {
  if (["idle", "notLoaded"].includes(status?.type)) return "idle";
  if (status?.type !== "active") return "unknown";
  if (status.activeFlags?.includes("waitingOnApproval"))
    return "waitingForApproval";
  if (status.activeFlags?.includes("waitingOnUserInput"))
    return "waitingForInput";
  return "running";
}

function discoverable(thread) {
  return (
    !thread.ephemeral &&
    thread.canAcceptDirectInput !== false &&
    !thread.archived &&
    !thread.path?.split(/[\\/]/).includes("archived_sessions")
  );
}

function isDelivery(item, envelope) {
  return (
    item.type === "functionCallOutput" &&
    item.name === notificationName &&
    item.namespace === codexConversationMcpName &&
    matchesConversationMessage(item.output, envelope)
  );
}

export function createCodexConversationManager({
  transport,
  subscriptions,
  busy,
  backgroundActivity,
  observeNativeWork,
  requestActivities = /** @type {(threadId: string) => string[]} */ (() => []),
}) {
  const leases = new Set();
  const reviewingTurns = new Map();
  const knownWork = new Set();

  function release(lease) {
    if (leases.delete(lease)) lease.release();
  }

  async function read(threadId) {
    if (!threadIdPattern.test(threadId)) return null;
    if (!transport.ready) throw new Error("Codex 后端尚未就绪。");
    try {
      const { thread } = await transport.call(
        "thread/read",
        { threadId, includeTurns: false },
        { trackThread: false },
      );
      return thread;
    } catch (error) {
      // For a valid ID, the native metadata-only read uses Invalid Request for a missing thread.
      if (error instanceof CodexRpcError && error.code === -32600) return null;
      throw error;
    }
  }

  async function observeThreads() {
    const activitySnapshot = await backgroundActivity();
    const threads = [];
    const parents = new Set();
    const observed = new Set();
    let { complete } = activitySnapshot;
    const candidates = [
      ...new Set([
        ...activitySnapshot.loaded,
        ...activitySnapshot.running,
        ...knownWork,
      ]),
    ];
    for (let offset = 0; offset < candidates.length; offset += 50) {
      const batch = candidates.slice(offset, offset + 50);
      const results = await Promise.allSettled(batch.map(read));
      if (!transport.ready) throw new Error("Codex 后端尚未就绪。");
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          complete = false;
          threads.push({
            threadId: batch[index],
            title: "",
            cwd: "",
            status: "unknown",
          });
          continue;
        }
        const thread = result.value;
        if (
          thread?.parentThreadId &&
          (thread.status?.type === "active" ||
            activitySnapshot.running.has(thread.id))
        )
          parents.add(thread.parentThreadId);
        if (!thread || !discoverable(thread)) {
          knownWork.delete(batch[index]);
          continue;
        }
        const requests = requestActivities(thread.id);
        threads.push({
          ...conversationIdentity(thread),
          status: requests[0] ?? activity(thread.status),
          background: activitySnapshot.running.has(thread.id),
          ...(requests.length
            ? { activities: requests }
            : thread.status?.activeFlags?.includes("waitingOnUserInput") &&
              thread.status.activeFlags.includes("waitingOnApproval") && {
                activities: ["waitingForInput"],
              }),
        });
        observed.add(thread.id);
      }
    }
    const missingParents = [...parents].filter((id) => !observed.has(id));
    for (let offset = 0; offset < missingParents.length; offset += 50) {
      const entries = await Promise.allSettled(
        missingParents.slice(offset, offset + 50).map(read),
      );
      for (const entry of entries) {
        if (entry.status === "rejected") complete = false;
        else if (entry.value && discoverable(entry.value))
          threads.push({
            ...conversationIdentity(entry.value),
            status: activity(entry.value.status),
          });
      }
    }
    for (let offset = 0; offset < threads.length; offset += 50)
      await Promise.all(
        threads.slice(offset, offset + 50).map(async (thread) => {
          const { threadId } = thread;
          const details =
            observeNativeWork && thread.status !== "unknown"
              ? await observeNativeWork(threadId)
              : { activities: [], complete: true };
          complete &&= details.complete;
          const activities = details.activities;
          if (activities.length) knownWork.add(threadId);
          else if (details.complete) knownWork.delete(threadId);
          if (parents.has(threadId)) activities.push("subAgents");
          if (activities.length)
            thread.activities = [...(thread.activities ?? []), ...activities];
        }),
      );
    return { threads, complete };
  }

  async function deliver(envelope) {
    const threadId = envelope.to.threadId;
    const replying = Boolean(envelope.replyTo);
    const blocked = () =>
      !transport.ready ||
      reviewingTurns.has(threadId) ||
      busy(threadId, replying);
    if (blocked()) return { status: "deferred" };
    const lease = {
      threadId,
      turnId: undefined,
      earlyCompletions: new Set(),
      release: subscriptions.retainThread(threadId),
    };
    leases.add(lease);
    try {
      const thread = await read(threadId);
      if (!thread)
        return { status: "failed", reason: "目标 Codex 会话已不存在。" };
      if (thread.ephemeral || thread.canAcceptDirectInput === false)
        return {
          status: "failed",
          reason: "目标 Codex 会话拒绝直接接收消息。",
        };
      if (
        blocked() ||
        (thread.status?.type === "active" &&
          (!replying || thread.status.activeFlags?.length !== 0))
      )
        return { status: "deferred" };
      try {
        await subscriptions.releasing.get(threadId);
        await subscriptions.resumeForWrite(threadId, {
          inheritPermissions: true,
        });
      } catch (error) {
        return {
          status:
            error instanceof CodexRpcError && error.code === -32600
              ? "failed"
              : "deferred",
          reason: error.message,
        };
      }
      if (blocked()) return { status: "deferred" };

      // Codex keeps a standalone tool result pending until the active turn can
      // consume it, or starts a new turn when the thread is idle.
      try {
        const { turn } = await transport.call("turn/start", {
          threadId,
          input: [],
          turnTrigger: "thread_chat",
          toolOutput: {
            name: notificationName,
            namespace: codexConversationMcpName,
            output: formatConversationMessage(
              envelope,
              codexConversationMcpName,
            ),
            retain: true,
          },
        });
        lease.turnId = turn.id;
        if (lease.earlyCompletions.has(turn.id)) release(lease);
        return { status: "queued", evidence: { turnId: turn.id } };
      } catch (error) {
        return {
          status:
            error instanceof CodexRpcError &&
            [-32601, -32602].includes(error.code)
              ? "failed"
              : "unknown",
          reason: error.message,
        };
      }
    } catch (error) {
      return { status: "deferred", reason: error.message };
    } finally {
      if (!lease.turnId) release(lease);
    }
  }

  async function reconcile(envelope, receipt) {
    const threadId = envelope.to.threadId;
    const evidence = receipt?.evidence;
    if (!transport.ready)
      return { status: evidence ? "queued" : "unknown", evidence };
    const readPage = (cursor) =>
      transport.call(
        "thread/turns/list",
        {
          threadId,
          sortDirection: "desc",
          itemsView: "full",
          limit: 20,
          cursor,
        },
        { trackThread: false },
      );
    const find = (page) => {
      for (const turn of page.data) {
        const item = turn.items?.find((item) => isDelivery(item, envelope));
        if (item)
          return {
            status: "delivered",
            evidence: { turnId: turn.id, itemId: item.id },
          };
      }
    };

    try {
      // Recheck the live page for an item added to a racing turn, then advance
      // at most one older page. The durable cursor also survives bridge restart.
      const latest = await readPage(undefined);
      const found = find(latest);
      if (found) return found;
      const cursor = Object.hasOwn(receipt ?? {}, "historyCursor")
        ? receipt.historyCursor
        : latest.nextCursor;
      const older = cursor ? await readPage(cursor) : null;
      const olderMatch = older && find(older);
      if (olderMatch) return olderMatch;
      const turn = [latest, older]
        .flatMap((page) => page?.data ?? [])
        .find((turn) => turn.id === evidence?.turnId);
      const queued = evidence && (!turn || turn.status === "inProgress");
      return {
        status: queued ? "queued" : "unknown",
        evidence,
        historyCursor: older?.nextCursor ?? null,
        ...(!queued &&
          evidence && {
            reason: "原生轮次已结束，历史尚无已投递的消息记录。",
          }),
      };
    } catch (error) {
      return {
        status: evidence ? "queued" : "unknown",
        evidence,
        historyCursor: undefined,
        reason: error.message,
      };
    }
  }

  return {
    observeThreads,
    async readThread(threadId) {
      const thread = await read(threadId);
      return thread
        ? {
            ...conversationIdentity(thread),
            ...(!discoverable(thread) && { discoverable: false }),
          }
        : null;
    },
    deliver,
    reconcile,
    /** @param {import("./native-protocol.d.mts").NativeEvent} message */
    onEvent({ method, params }) {
      const { threadId, turnId, item, turn } = params ?? {};
      if (!threadId) return;
      if (["thread/queue/changed", "thread/goal/updated"].includes(method))
        knownWork.add(threadId);
      const closed = [
        "thread/closed",
        "thread/deleted",
        "thread/archived",
      ].includes(method);
      if (
        method === "item/started" &&
        item?.type === "enteredReviewMode" &&
        turnId
      )
        reviewingTurns.set(threadId, turnId);
      if (
        closed ||
        (method === "turn/completed" &&
          turn?.id === reviewingTurns.get(threadId))
      )
        reviewingTurns.delete(threadId);
      for (const lease of leases) {
        if (lease.threadId !== threadId) continue;
        if (closed) release(lease);
        if (method !== "turn/completed" || !turn?.id) continue;
        if (turn.id === lease.turnId) release(lease);
        else if (!lease.turnId) lease.earlyCompletions.add(turn.id);
      }
    },
    disconnected() {
      reviewingTurns.clear();
      for (const lease of leases) release(lease);
    },
  };
}

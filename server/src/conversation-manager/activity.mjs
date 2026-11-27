import {
  resourceId,
  resourceTarget,
} from "../../../shared/backend-identity.mjs";
import { isCompacting } from "../../../shared/compaction-state.mjs";
import { requestActivity } from "./request-activity.mjs";

const activityOrder = [
  "waitingForApproval",
  "waitingForInput",
  "compacting",
  "reverting",
  "running",
  "queued",
  "goal",
  "background",
  "delegating",
  "subAgents",
  "collaborating",
  "waitingForPeer",
];

function projectConversationActivity(thread, extra = []) {
  const observed = thread.status ?? "unknown";
  const facts = new Set([...extra, ...(thread.activities ?? [])]);
  if (activityOrder.includes(observed)) facts.add(observed);
  if (thread.background) facts.add("background");
  const activities = activityOrder.filter((activity) => facts.has(activity));
  const status = activities[0] ?? (observed === "idle" ? "idle" : "unknown");
  return {
    ...thread,
    activities,
    status,
    generating:
      !["compacting", "waitingForInput", "waitingForApproval"].some(
        (activity) => facts.has(activity),
      ) &&
      (thread.generating ?? facts.has("running")),
    background: facts.has("background"),
    delegating: facts.has("delegating"),
    live: activities.length > 0,
  };
}

function addFact(facts, id, activity) {
  const entries = facts.get(id) ?? new Set();
  entries.add(activity);
  facts.set(id, entries);
}

function runtimeActivityFacts({
  activeTurns = {},
  compactions = {},
  questions = [],
  queuedInputs = {},
}) {
  const facts = new Map();
  for (const id of Object.keys(activeTurns)) addFact(facts, id, "running");
  for (const [id, state] of Object.entries(compactions))
    if (isCompacting(state)) addFact(facts, id, "compacting");
  for (const id of Object.keys(queuedInputs)) addFact(facts, id, "queued");
  for (const { method, params } of questions) {
    const activity = requestActivity(method, params);
    if (params?.threadId && activity) addFact(facts, params.threadId, activity);
  }
  return facts;
}

export function createActivitySource(readRuntime, readDelegations) {
  const reverting = new Map();
  return {
    async snapshot() {
      const [delegations] = await Promise.allSettled([readDelegations()]);
      const runtime = readRuntime();
      const facts = runtimeActivityFacts(runtime);
      for (const id of reverting.keys()) addFact(facts, id, "reverting");
      return {
        activeTurns: runtime.activeTurns ?? {},
        facts,
        delegations:
          delegations.status === "fulfilled" ? delegations.value : [],
        complete: delegations.status === "fulfilled",
      };
    },
    async trackRevert(threadId, execute) {
      reverting.set(threadId, (reverting.get(threadId) ?? 0) + 1);
      try {
        return await execute();
      } finally {
        const remaining = reverting.get(threadId) - 1;
        if (remaining) reverting.set(threadId, remaining);
        else reverting.delete(threadId);
      }
    },
  };
}

function backendFacts(entry, runtimeId, snapshot, peers) {
  const facts = new Map();
  for (const [resource, activities] of snapshot.facts) {
    const { backendId, nativeId } = resourceTarget(resource);
    if (backendId === entry.backendId) facts.set(nativeId, new Set(activities));
  }
  for (const { threadId, sourceRuntime } of snapshot.delegations) {
    const { backendId, nativeId } = resourceTarget(threadId);
    if (backendId === entry.backendId && sourceRuntime === runtimeId)
      addFact(facts, nativeId, "delegating");
  }
  for (const { threadId, activity } of peers(runtimeId))
    addFact(facts, threadId, activity);
  return facts;
}

export function createConversationActivity(readPeers) {
  const pending = new WeakMap();
  return async function observe(entry, runtimeId, snapshot) {
    const adapter = entry.getAdapter();
    if (!adapter) return { threads: [], complete: false };
    const facts = backendFacts(entry, runtimeId, snapshot, readPeers);
    let observation = pending.get(adapter);
    if (!observation) {
      observation = Promise.resolve()
        .then(() => adapter.observeThreads())
        .finally(() => pending.delete(adapter));
      pending.set(adapter, observation);
    }
    const result = await observation;
    const records = new Map(
      result.threads.map((thread) => [thread.threadId, thread]),
    );
    let { complete } = result;
    const missing = [...facts.keys()].filter((id) => !records.has(id));
    for (let offset = 0; offset < missing.length; offset += 50) {
      const ids = missing.slice(offset, offset + 50);
      const identities = await Promise.allSettled(
        ids.map((id) => adapter.readThread(id)),
      );
      for (const [index, identity] of identities.entries()) {
        if (identity.status === "rejected") {
          complete = false;
          continue;
        }
        if (identity.value && identity.value.discoverable !== false)
          records.set(ids[index], { ...identity.value, status: "idle" });
      }
    }
    if (entry.getAdapter() !== adapter) return { threads: [], complete: false };
    return {
      complete,
      threads: [...records.values()].map((record) =>
        projectConversationActivity(record, facts.get(record.threadId)),
      ),
    };
  };
}

export async function listConversationActivities(backends, observe, snapshot) {
  const entries = [...backends].filter(([, entry]) => entry.enabled);
  const observed = await Promise.allSettled(
    entries.map(([runtimeId, entry]) => observe(entry, runtimeId, snapshot)),
  );
  const threads = new Map();
  let complete = snapshot.complete;
  for (const [index, result] of observed.entries()) {
    const [runtimeId, entry] = entries[index];
    if (result.status === "rejected" || backends.get(runtimeId) !== entry) {
      complete = false;
      continue;
    }
    complete &&= result.value.complete;
    for (const record of result.value.threads)
      threads.set(resourceId(entry.backendId, record.threadId), record);
  }
  // The ACP backend exposes runtime and delegation facts without a peer MCP adapter.
  for (const [threadId, facts] of snapshot.facts)
    if (resourceTarget(threadId).backendId === "agy")
      threads.set(
        threadId,
        projectConversationActivity({ status: "idle" }, facts),
      );
  for (const { threadId } of snapshot.delegations)
    if (resourceTarget(threadId).backendId === "agy") {
      const facts = snapshot.facts.get(threadId) ?? [];
      threads.set(
        threadId,
        projectConversationActivity({ status: "idle" }, [
          ...facts,
          "delegating",
        ]),
      );
    }
  return {
    activities: [...threads]
      .filter(([, record]) => record.live || record.status === "unknown")
      .map(
        ([
          threadId,
          { status, activities, live, generating, background, delegating },
        ]) => ({
          threadId,
          status,
          activities,
          live,
          generating,
          background,
          delegating,
          ...(snapshot.activeTurns[threadId] && {
            turnId: snapshot.activeTurns[threadId],
          }),
        }),
      )
      .sort((a, b) => a.threadId.localeCompare(b.threadId)),
    complete,
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

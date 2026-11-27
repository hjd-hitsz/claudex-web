import { nowSeconds } from "./session-store.mjs";
import { readAgyCheckpoint } from "./tmp_function/compaction-checkpoint.mjs";

const statuses = {
  in_progress: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "interrupted",
};

export function createAgyCompactions(readCheckpoint = readAgyCheckpoint) {
  const entries = new Map();

  function track(activity, notify) {
    const { session, turn } = activity;
    const manual = activity.input.compaction;
    let entry;
    let native;
    let checkpoint;
    let agent;
    let nativeId;
    const publish = () => {
      entries.set(session.id, entry);
      notify("lan/compaction", { compaction: entry });
    };
    function start(id, source) {
      entry = {
        id,
        turnId: turn.id,
        status: "running",
        source,
        startedAt: nowSeconds(),
      };
      publish();
    }
    if (manual) start(turn.id, "manual");

    return {
      prepare(id, agentInfo) {
        nativeId = id;
        agent = agentInfo;
        checkpoint = readCheckpoint(nativeId, agent);
      },
      update(update) {
        if (update.sessionUpdate === "compaction_summary_chunk") return true;
        if (update.sessionUpdate !== "compaction_update") return false;
        const status = statuses[update.status];
        if (!Object.hasOwn(statuses, update.status) || !update.compactionId)
          return true;
        if (!entry || (!manual && native?.id !== update.compactionId)) {
          if (status === "running") start(update.compactionId, "automatic");
          else
            entry = {
              id: update.compactionId,
              turnId: turn.id,
              source: "automatic",
              startedAt: nowSeconds(),
            };
        }
        native = { id: update.compactionId, status, error: update.error };
        return true;
      },
      finish() {
        const next =
          checkpoint == null ? null : readCheckpoint(nativeId, agent);
        const saved = next != null && next > checkpoint;
        if (!entry && saved)
          entry = {
            id: turn.id,
            turnId: turn.id,
            source: "automatic",
            startedAt: turn.startedAt,
          };
        if (!entry) return;
        const status =
          activity.compactionApplied || native?.status === "completed" || saved
            ? "completed"
            : native?.status === "failed" || native?.status === "interrupted"
              ? native.status
              : turn.status === "completed"
                ? "unconfirmed"
                : turn.status;
        entry = {
          ...entry,
          status,
          completedAt: nowSeconds(),
          ...((native?.error || turn.error?.message) && {
            error: native?.error || turn.error.message,
          }),
        };
        turn.compaction = entry;
        if (status === "completed")
          turn.items.push({ id: entry.id, type: "contextCompaction" });
        return entry;
      },
      publish,
    };
  }

  return { entries, track };
}

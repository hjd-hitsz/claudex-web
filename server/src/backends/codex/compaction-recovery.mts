import {
  findCompactionTurn,
  recoverCompaction,
} from "../../../../shared/compaction-state.mjs";
import type { CompactionTurn } from "../../../../shared/compaction-state.mjs";
import type { CompactionEntry, createCompactions } from "../../compaction.mjs";
import type { createSubscriptions } from "./subscriptions.mjs";
import type { createUpstream } from "./upstream.mjs";

type RecoveryDependencies = Pick<
  ReturnType<typeof createSubscriptions>,
  "resumeForWrite" | "releaseUnusedThreads"
> & {
  transport: Pick<ReturnType<typeof createUpstream>, "call" | "pending">;
  compactions: ReturnType<typeof createCompactions>;
};

export function createCompactionRecovery({
  transport,
  compactions,
  resumeForWrite,
  releaseUnusedThreads,
}: RecoveryDependencies) {
  const checkingCompactions = new Map<
    string,
    Promise<CompactionEntry | undefined>
  >();
  function checkCompaction(threadId: string) {
    const previous = checkingCompactions.get(threadId);
    if (previous) return previous;
    const entry = compactions.entries.get(threadId);
    if (!entry || !compactions.busy(threadId)) return Promise.resolve(entry);
    if (
      [...transport.pending.values()].some(
        (request) =>
          request.threadId === threadId &&
          request.method === "thread/compact/start",
      )
    )
      return Promise.resolve(entry);
    const current = () => {
      const latest = compactions.entries.get(threadId);
      return latest?.id === entry.id && compactions.busy(threadId)
        ? latest
        : undefined;
    };
    const checking = (async () => {
      try {
        const { thread } = await transport.call("thread/read", {
          threadId,
          includeTurns: false,
        });
        let cursor: string | null | undefined;
        const turns: CompactionTurn[] = [];
        do {
          const page = await transport.call("thread/turns/list", {
            threadId,
            limit: 100,
            itemsView: "full",
            ...(cursor ? { cursor } : {}),
          });
          const latest = current();
          if (!latest) return compactions.entries.get(threadId);
          turns.push(...page.data);
          cursor = page.nextCursor;
          if (findCompactionTurn(latest, turns)) break;
        } while (cursor);
        const latest = current();
        if (!latest) return compactions.entries.get(threadId);
        const recovered = recoverCompaction(latest, thread, turns);
        if (recovered.status === "running") {
          await resumeForWrite(threadId);
        }
        if (current()) compactions.update(threadId, recovered);
        return compactions.entries.get(threadId);
      } catch (error) {
        const latest = current();
        if (latest)
          compactions.update(threadId, {
            ...latest,
            status: "reconnecting",
            error: error instanceof Error ? error.message : String(error),
          });
        throw error;
      } finally {
        checkingCompactions.delete(threadId);
        releaseUnusedThreads();
      }
    })();
    checkingCompactions.set(threadId, checking);
    return checking;
  }
  return checkCompaction;
}

import { resourceTarget } from "../../shared/backend-identity.mjs";

export function createTokenUsageReconciliation({ store, call, current }) {
  const jobs = new Map();
  async function run(entry, status, signal) {
    let archiveCursor;
    do {
      const revisions = store.revisions();
      const page = await call(
        entry,
        "thread/list",
        {
          archived: true,
          limit: 100,
          ...(archiveCursor && { cursor: archiveCursor }),
        },
        { signal },
      );
      for (const thread of page.data || []) {
        if (!current(entry) || signal.aborted) return;
        if (store.revision(thread.id) === (revisions.get(thread.id) ?? 0))
          store.archive(thread.id);
        status.archived++;
      }
      archiveCursor = page.nextCursor;
    } while (archiveCursor && current(entry) && !signal.aborted);
    let cursor;
    do {
      const page = await call(
        entry,
        "thread/list",
        {
          archived: false,
          limit: 100,
          ...(cursor && { cursor }),
        },
        { signal },
      );
      for (const thread of page.data || []) {
        if (!current(entry) || signal.aborted) return;
        if (thread.path?.includes("/archived_sessions/")) continue;
        status.checked++;
        try {
          if (await store.read(thread.id)) continue;
          const result = await call(
            entry,
            "thread/read",
            {
              threadId: resourceTarget(thread.id, entry.backend.id).nativeId,
              includeTurns: false,
            },
            { signal },
          );
          if (result.thread?.tokenUsage) status.imported++;
          else status.unavailable++;
        } catch (error) {
          status.failed++;
          status.error = error.message;
        }
      }
      cursor = page.nextCursor;
    } while (cursor && current(entry) && !signal.aborted);
    await store.flush();
  }
  return {
    start(entry) {
      if (
        !current(entry) ||
        !entry.adapter?.ready ||
        jobs.get(entry.backend.id)?.entry === entry
      )
        return;
      const status = {
        status: "running",
        checked: 0,
        archived: 0,
        imported: 0,
        unavailable: 0,
        failed: 0,
        error: null,
      };
      const controller = new AbortController();
      const promise = run(entry, status, controller.signal)
        .then(() => {
          status.status = current(entry) ? "completed" : "stopped";
        })
        .catch((error) => {
          status.status = controller.signal.aborted ? "stopped" : "failed";
          status.error = controller.signal.aborted ? null : error.message;
        })
        .finally(() =>
          console.log(
            `后端 ${entry.backend.id} token 用量启动核对：${JSON.stringify(status)}`,
          ),
        );
      jobs.set(entry.backend.id, { entry, status, promise, controller });
    },
    snapshot: () =>
      Object.fromEntries([...jobs].map(([id, job]) => [id, { ...job.status }])),
    flush: () => Promise.all([...jobs.values()].map((job) => job.promise)),
    stop: () => {
      for (const job of jobs.values()) job.controller.abort();
    },
  };
}

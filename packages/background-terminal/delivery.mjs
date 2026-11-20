import { randomUUID } from "node:crypto";
import { mcpConfig } from "./client.mjs";
import { withCodex } from "./codex.mjs";

export async function received(call, batch) {
  let cursor;
  do {
    const page = await call("thread/turns/list", {
      threadId: batch.threadId,
      itemsView: "full",
      limit: 100,
      cursor,
    });
    for (const turn of page.data) {
      for (const item of turn.items ?? []) {
        if (
          item.type !== "functionCallOutput" ||
          item.name !== "background_completed"
        )
          continue;
        const output =
          typeof item.output === "string"
            ? item.output
            : item.output?.map((p) => p.text).join("");
        try {
          if (JSON.parse(output).notification_id === batch.id) return true;
        } catch {}
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return false;
}

export function createDelivery(directory, url, jobs) {
  const owner = randomUUID();
  const active = new Map();
  const retryAt = new Map();
  let closed = false;
  async function deliver(threadId, existing) {
    let batch;
    let sending = false;
    try {
      await withCodex(url, async (call) => {
        if (
          existing?.status === "uncertain" ||
          existing?.status === "sending"
        ) {
          if (await received(call, existing))
            await jobs.updateBatch({ id: existing.id, status: "accepted" });
          else retryAt.set(existing.id, Date.now() + 30000);
          return;
        }
        const { thread } = await call("thread/read", {
          threadId,
          includeTurns: false,
        });
        if (thread.archived || thread.path?.includes("/archived_sessions/")) {
          await jobs.suppressThread(threadId);
          return;
        }
        if (thread.status?.type === "active" || closed) return;
        batch = await jobs.claim(threadId, owner);
        if (!batch) return;
        const resumed = await call("thread/resume", {
          threadId,
          excludeTurns: true,
          config: mcpConfig(directory, url),
        });
        if (resumed.thread.status?.type === "active" || closed) {
          await jobs.updateBatch({ id: batch.id, owner, status: "pending" });
          return;
        }
        const results = [];
        for (const id of batch.jobIds) {
          const { job, output } = await jobs.read(threadId, id);
          results.push({
            job_id: id,
            title: job.title,
            status: job.status,
            exit_code: job.exitCode,
            output_tail: [...output].slice(-3000).join(""),
            ...(job.native && { native_session_id: job.native.processId }),
          });
        }
        const marked = await jobs.updateBatch({
          id: batch.id,
          owner,
          status: "sending",
        });
        if (marked.status !== "sending") return;
        sending = true;
        const result = await call("turn/start", {
          threadId,
          input: [],
          turnTrigger: "background_task",
          toolOutput: {
            name: "background_completed",
            output: JSON.stringify({
              notification_id: batch.id,
              results: results.filter((r) =>
                marked.deliveryJobIds.includes(r.job_id),
              ),
            }),
          },
        });
        await jobs.updateBatch({
          id: batch.id,
          status: "accepted",
          turnId: result.turn.id,
          owner,
        });
      });
    } catch (error) {
      retryAt.set(existing?.id ?? threadId, Date.now() + 10000);
      if (batch)
        await jobs.updateBatch({
          id: batch.id,
          owner,
          status: sending && !error.rpcRejected ? "uncertain" : "pending",
          error: error.message,
        });
      console.error("后台结果投递", threadId, error.message);
    }
  }
  const timer = setInterval(() => {
    const { jobs: records, batches } = jobs.snapshot();
    const threads = new Set(
      records
        .filter((j) => j.completedAt && j.delivery === "pending")
        .map((j) => j.threadId),
    );
    const queued = new Map();
    for (const batch of batches) {
      if (["accepted", "suppressed"].includes(batch.status)) continue;
      if (batch.status === "pending" || batch.status === "preparing")
        threads.add(batch.threadId);
      else queued.set(batch.id, batch);
    }
    for (const threadId of threads) queued.set(threadId, null);
    for (const [key, batch] of queued) {
      if (active.has(key) || Date.now() < (retryAt.get(key) || 0)) continue;
      active.set(
        key,
        deliver(batch?.threadId ?? key, batch)
          .catch((e) => console.error(e.message))
          .finally(() => active.delete(key)),
      );
    }
  }, 1000);
  return async () => {
    closed = true;
    clearInterval(timer);
    await Promise.all(active.values());
  };
}

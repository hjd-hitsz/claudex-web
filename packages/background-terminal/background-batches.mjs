import { randomUUID } from "node:crypto";

const QUEUED = ["pending", "preparing"];
const SETTLED = ["accepted", "suppressed"];
const EXCLUDED = ["consumed", "suppressed"];

export function createBackgroundBatches({ jobs, batches, save, running, now }) {
  const checks = new Map();
  const batchItems = (batch) =>
    batch.jobIds.map((id) => jobs.get(id)).filter(Boolean);
  const eligible = (batch, job) =>
    batch.checkpoints
      ? running(job) && job.checkpoint?.id === batch.checkpoints[job.id]?.id
      : !EXCLUDED.includes(job.delivery);
  const remaining = (batch) =>
    batchItems(batch).filter((job) => eligible(batch, job));
  function index(batch) {
    for (const check of Object.values(batch.checkpoints ?? {}))
      checks.set(check.id, batch);
  }
  async function restore() {
    for (const batch of batches.values()) {
      index(batch);
      if (!batch.checkpoints) {
        for (const job of remaining(batch)) {
          job.delivery = batch.status;
          await save("job", job.id, job);
        }
      } else if (QUEUED.includes(batch.status) && !remaining(batch).length) {
        batch.status = "suppressed";
        await save("batch", batch.id, batch);
      }
    }
  }

  function checkpointView(job) {
    const check = job.checkpoint;
    if (!check || !running(job)) return {};
    const batch = checks.get(check.id);
    if (SETTLED.includes(batch?.status)) return {};
    return {
      nextCheckAt: check.dueAt,
      ...(batch?.status === "uncertain" && { checkDelivery: "uncertain" }),
    };
  }
  const due = (job, time) =>
    running(job) &&
    job.checkpoint &&
    job.checkpoint.dueAt <= time &&
    !checks.has(job.checkpoint.id);
  function dueThreads() {
    const time = now();
    return [
      ...new Set(
        [...jobs.values()]
          .filter((job) => due(job, time))
          .map((job) => job.threadId),
      ),
    ];
  }
  function recentChecks(threadId) {
    return [...batches.values()]
      .filter(
        (batch) =>
          batch.threadId === threadId &&
          batch.checkpoints &&
          batch.status === "accepted",
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 20)
      .map((batch) => ({ id: batch.id, deliveredAt: batch.updatedAt }));
  }

  async function claim(threadId, owner) {
    const queued = [...batches.values()].filter(
      (batch) => batch.threadId === threadId && QUEUED.includes(batch.status),
    );
    const completion = queued.find((batch) => !batch.checkpoints);
    const records = [...jobs.values()].filter(
      (job) => job.threadId === threadId,
    );
    const finished = records.filter(
      (job) =>
        job.completedAt &&
        job.delivery === "pending" &&
        job.status !== "cancelled",
    );
    const stale = queued.filter(
      (batch) => batch.checkpoints && !remaining(batch).length,
    );
    const savedStale = Promise.all(
      stale.map((batch) => updateBatch({ id: batch.id, status: "suppressed" })),
    );
    const existing =
      completion ??
      (!finished.length &&
        queued.find(
          (batch) => batch.checkpoints && QUEUED.includes(batch.status),
        ));
    const time = now();
    if (existing) {
      if (
        !QUEUED.includes(existing.status) ||
        (existing.status === "preparing" &&
          existing.owner !== owner &&
          time - existing.updatedAt < 120000)
      ) {
        await savedStale;
        return null;
      }
      Object.assign(existing, { owner, status: "preparing", updatedAt: time });
      await Promise.all([save("batch", existing.id, existing), savedStale]);
      return existing;
    }

    const selected = (
      finished.length ? finished : records.filter((job) => due(job, time))
    ).slice(0, 8);
    if (!selected.length) {
      await savedStale;
      return null;
    }
    const batch = {
      id: randomUUID(),
      threadId,
      jobIds: selected.map((job) => job.id),
      ...(!finished.length && {
        checkpoints: Object.fromEntries(
          selected.map((job) => [job.id, job.checkpoint]),
        ),
      }),
      owner,
      status: "preparing",
      updatedAt: time,
    };
    batches.set(batch.id, batch);
    index(batch);
    const saved = save("batch", batch.id, batch);
    if (!batch.checkpoints)
      for (const job of selected) job.delivery = "batched";
    await Promise.all([saved, savedStale]);
    if (!batch.checkpoints)
      await Promise.all(selected.map((job) => save("job", job.id, job)));
    return batch;
  }

  async function updateBatch({ id, status, error, turnId, owner }) {
    const batch = batches.get(id);
    if (!batch) throw new Error("后台通知不存在");
    if (owner && batch.owner !== owner)
      throw new Error("后台通知已由另一服务处理");
    if (
      !["pending", "sending", "accepted", "uncertain", "suppressed"].includes(
        status,
      )
    )
      throw new Error("无效投递状态");
    if (SETTLED.includes(batch.status)) return batch;
    const current = remaining(batch);
    if (status === "sending") {
      batch.attemptedAt = now();
      batch.deliveryJobIds = current.map((job) => job.id);
      if (!current.length) status = "suppressed";
    }
    Object.assign(batch, { status, error, turnId, updatedAt: now() });
    const saved = [save("batch", id, batch)];
    if (!batch.checkpoints)
      for (const job of current) {
        job.delivery = status;
        job.deliveryError = error;
        saved.push(save("job", job.id, job));
      }
    await Promise.all(saved);
    return batch;
  }

  function readyToSend(batch) {
    if (batch.status !== "sending") return [];
    return (batch.deliveryJobIds ?? []).filter(
      (id) => jobs.has(id) && eligible(batch, jobs.get(id)),
    );
  }
  async function consumeCompletion(job) {
    if (!["pending", "batched", "preparing"].includes(job.delivery)) return;
    job.delivery = "consumed";
    const saved = [save("job", job.id, job)];
    for (const batch of batches.values())
      if (
        !batch.checkpoints &&
        batch.jobIds.includes(job.id) &&
        !remaining(batch).length
      )
        saved.push(updateBatch({ id: batch.id, status: "suppressed" }));
    await Promise.all(saved);
  }
  async function suppressBatches(threadId) {
    await Promise.all(
      [...batches.values()]
        .filter((batch) => batch.threadId === threadId)
        .map((batch) => updateBatch({ id: batch.id, status: "suppressed" })),
    );
  }
  return {
    restore,
    checkpointView,
    dueThreads,
    recentChecks,
    claim,
    updateBatch,
    readyToSend,
    consumeCompletion,
    suppressBatches,
  };
}

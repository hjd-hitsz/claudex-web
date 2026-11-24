import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createBackgroundJobs } from "../../packages/background-terminal/background-jobs.mjs";
import {
  BACKGROUND_TOOLS,
  MIN_CHECK_DELAY_MS,
} from "../../packages/background-terminal/background-protocol.mjs";
import { received } from "../../packages/background-terminal/delivery.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "claudex-checkpoints-"));
  let now = Date.now();
  const stopped = [];
  const options = {
    directory,
    now: () => now,
    shell: "/bin/sh",
    readThread: async () => ({ cwd: directory }),
    terminateNative: async (job) => {
      stopped.push(job.id);
      return { terminated: true };
    },
  };
  const jobs = await createBackgroundJobs(options);
  const threadId = "checkpoint-session";
  const tool = (name, args, callId, owner = threadId) =>
    jobs.tool({ name, args, callId, threadId: owner });
  const schedule = (job_id, check_after_ms, callId, owner) =>
    tool(
      "background_schedule_check",
      { job_id, check_after_ms },
      callId,
      owner,
    );
  const start = (callId = "start") =>
    tool(
      "background_start",
      {
        title: "受控任务",
        command:
          "printf started; while [ ! -f release ]; do sleep 0.01; done; printf done",
        check_after_ms: MIN_CHECK_DELAY_MS,
      },
      callId,
    );
  const read = (id) => tool("background_read", { job_id: id });
  const list = () => tool("background_list", {});
  const claim = () => jobs.claim(threadId, "owner");
  const update = (batch, status) =>
    jobs.updateBatch({ id: batch.id, status, owner: "owner" });
  const registerNative = (id) =>
    jobs.registerNative(threadId, "native-turn", {
      id,
      processId: id + "-pid",
      command: "fixture",
      cwd: directory,
    });
  async function waitForExit() {
    for (let i = 0; i < 200; i++) {
      const found = jobs.list(threadId).find((entry) => entry.completedAt);
      if (found) return found;
      await delay(10);
    }
    assert.fail("隔离后台进程未退出");
  }
  t.after(async () => {
    await jobs.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    threadId,
    directory,
    jobs,
    start,
    read,
    list,
    tool,
    schedule,
    claim,
    update,
    registerNative,
    stopped,
    waitForExit,
    options,
    release: () => writeFile(join(directory, "release"), ""),
    advance: (ms) => (now += ms),
  };
}

test("启动和改期均要求提供真实检查间隔，拒绝秒级间隔", async (t) => {
  const f = await fixture(t);
  for (const name of ["background_start", "background_schedule_check"]) {
    const schema = BACKGROUND_TOOLS.find(
      (entry) => entry.name === name,
    ).inputSchema;
    assert.ok(schema.required.includes("check_after_ms"));
    assert.equal(schema.properties.check_after_ms.minimum, 60_000);
    const args =
      name === "background_start"
        ? { title: "隔离任务", command: "true" }
        : { job_id: "missing" };
    await assert.rejects(
      f.tool(name, args, "missing"),
      /缺少必填参数：check_after_ms/,
    );
    for (const value of [1000, 59_999, 604_800_001, 60_000.1, "60000", null])
      await assert.rejects(
        f.tool(name, { ...args, check_after_ms: value }, "bad"),
        /check_after_ms/,
      );
  }
  assert.deepEqual(f.jobs.list(), []);
});

test("到期检查保留原进程，改期只在新时间触发，完成结果独立交付", async (t) => {
  const f = await fixture(t);
  const { job } = await f.start();
  const jobPath = join(f.directory, `job-${job.id}.json`);
  const pid = JSON.parse(await readFile(jobPath, "utf8")).pid;
  assert.equal((await f.start()).job.nextCheckAt, job.nextCheckAt);
  assert.deepEqual(f.jobs.snapshot().dueChecks, []);
  f.advance(MIN_CHECK_DELAY_MS);
  assert.deepEqual(f.jobs.snapshot().dueChecks, [f.threadId]);

  const first = await f.claim();
  assert.equal(first.checkpoints[job.id].dueAt, job.nextCheckAt);
  await f.update(first, "sending");
  assert.deepEqual(f.jobs.readyToSend(first), [job.id]);
  await f.update(first, "accepted");
  process.kill(pid, 0);
  assert.equal((await f.read(job.id)).job.status, "running");
  assert.equal((await f.list()).jobs[0].delivery, "pending");
  assert.equal((await f.list()).jobs[0].nextCheckAt, undefined);
  assert.equal((await f.list()).checks[0].id, first.id);
  assert.equal(await f.claim(), null);

  const { job: rescheduled } = await f.schedule(job.id, 300_000, "rearm");
  f.advance(60_000);
  assert.equal(
    (await f.schedule(job.id, 300_000, "rearm")).job.nextCheckAt,
    rescheduled.nextCheckAt,
  );
  assert.equal(await f.claim(), null);
  f.advance(240_000);
  const second = await f.claim();
  assert.notEqual(second.checkpoints[job.id].id, first.checkpoints[job.id].id);
  await f.update(second, "sending");
  await f.update(second, "accepted");
  assert.equal(JSON.parse(await readFile(jobPath, "utf8")).pid, pid);

  await f.release();
  const finished = await f.waitForExit();
  assert.equal(finished.status, "succeeded");
  const completion = await f.claim();
  assert.equal(completion.checkpoints, undefined);
  assert.deepEqual(completion.jobIds, [job.id]);
  await f.update(completion, "sending");
  await f.update(completion, "accepted");
  assert.equal((await f.list()).checks.length, 2);
  assert.equal((await f.list()).jobs[0].delivery, "accepted");
});

test("原生终端检查隔离所属会话，改期、停止和完成会使旧提醒失效", async (t) => {
  const f = await fixture(t);
  const finished = await f.registerNative("finish");
  const stopped = await f.registerNative("stop");
  const replaced = await f.registerNative("replace");
  await assert.rejects(
    f.schedule(finished.id, 60_000, "bad", "other"),
    /该对话/,
  );
  for (const job of [finished, stopped, replaced])
    await f.schedule(job.id, 60_000, job.id);
  f.advance(60_000);
  const batch = await f.claim();
  await f.update(batch, "sending");

  await f.schedule(replaced.id, 240_000, "new-estimate");
  const { job: replay } = await f.schedule(replaced.id, 60_000, replaced.id);
  assert.equal(replay.nextCheckAt, f.advance(0) + 240_000);
  await f.tool("background_cancel", { job_id: stopped.id });
  await f.jobs.finishNative(f.threadId, finished.id, {
    status: "completed",
    exitCode: 0,
  });
  assert.deepEqual(f.jobs.readyToSend(batch), []);
  assert.deepEqual(f.stopped, [stopped.id]);
  await f.update(batch, "suppressed");
  await assert.rejects(f.schedule(finished.id, 60_000, "too-late"), /仍在运行/);
  const completion = await f.claim();
  assert.deepEqual(completion.jobIds, [finished.id]);
  assert.equal(completion.checkpoints, undefined);
  await f.update(completion, "accepted");
  assert.equal(await f.claim(), null);
});

test("恢复时待核对的检查回执不会占用任务完成通知", async (t) => {
  const f = await fixture(t);
  const job = await f.registerNative("restart");
  await f.schedule(job.id, 60_000, "initial");
  f.advance(60_000);
  const batch = await f.claim();
  await f.update(batch, "sending");

  const restored = await createBackgroundJobs(f.options);
  t.after(() => restored.close());
  const unknown = restored.snapshot().batches.find(({ id }) => id === batch.id);
  assert.equal(unknown.status, "uncertain");
  assert.equal(restored.list()[0].status, "interrupted");
  const callWithHistory = (name) => async () => ({
    data: [
      {
        items: [
          {
            name,
            type: "functionCallOutput",
            output: JSON.stringify({ notification_id: batch.id }),
          },
        ],
      },
    ],
  });
  assert.equal(
    await received(callWithHistory("background_completed"), unknown),
    false,
  );
  assert.equal(
    await received(callWithHistory("background_check_due"), unknown),
    true,
  );
  await restored.updateBatch({ id: batch.id, status: "accepted" });
  assert.equal(restored.list()[0].delivery, "pending");
  const completion = await restored.claim(f.threadId, "another-owner");
  assert.deepEqual(completion.jobIds, [job.id]);
  assert.equal(completion.checkpoints, undefined);
});

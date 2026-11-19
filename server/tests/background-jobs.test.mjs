import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBackgroundJobs } from "../../packages/background-terminal/background-jobs.mjs";

const command = (script) =>
  `'${process.execPath.replaceAll("'", "'\\''")}' -e '${script.replaceAll("'", "'\\''")}'`;
async function until(read) {
  for (let i = 0; i < 500; i++) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  assert.fail("等待后台任务超时");
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "codex-web-jobs-"));
  const config = {
    directory,
    shell: "/bin/sh",
    readThread: async (id) => ({ id, cwd: directory }),
  };
  const jobs = await createBackgroundJobs(config);
  t.after(async () => {
    await jobs.close();
    await rm(directory, { recursive: true, force: true });
  });
  const start = (id, script, extra = {}) =>
    jobs.tool({
      name: "background_start",
      threadId: "thread-a",
      callId: id,
      args: { command: command(script), title: "隔离测试任务", ...extra },
    });
  return {
    directory,
    config,
    jobs,
    start,
    done: (id) =>
      until(() => jobs.list().find((job) => job.id === id && job.completedAt)),
  };
}

test("后台任务按调用去重、按对话隔离，并完整读取 UTF-8 分页日志", async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([
    f.start("same-call", 'process.stdout.write("😀".repeat(12000))'),
    f.start("same-call", 'process.stdout.write("duplicate")'),
  ]);
  assert.equal(a.job.id, b.job.id);
  await f.done(a.job.id);
  assert.equal(f.jobs.list().length, 1);
  await assert.rejects(f.jobs.read("other-thread", a.job.id), /该对话/);
  let offset = 0,
    text = "";
  do {
    const page = await f.jobs.read("thread-a", a.job.id, offset);
    text += page.output;
    offset = page.nextOffset;
    if (offset === page.bytes) break;
  } while (true);
  assert.equal(text, "😀".repeat(12000));
  assert.equal(f.jobs.list()[0].status, "succeeded");
});

test("失败、超时、取消和服务停止均持久保存，并取消指定任务的自动续跑", async (t) => {
  const f = await fixture(t);
  const failed = await f.start(
    "failed",
    'console.error("失败日志");process.exit(7)',
  );
  assert.equal((await f.done(failed.job.id)).exitCode, 7);
  const timeout = await f.start("timeout", "setInterval(()=>{},1000)", {
    timeout_ms: 100,
  });
  assert.equal((await f.done(timeout.job.id)).status, "timed_out");
  const cancelled = await f.start("cancelled", "setInterval(()=>{},1000)");
  await f.jobs.tool({
    name: "background_cancel",
    threadId: "thread-a",
    args: { job_id: cancelled.job.id },
  });
  const result = await f.done(cancelled.job.id);
  assert.equal(result.status, "cancelled");
  assert.equal(result.delivery, "suppressed");
  const alive = await f.start("alive", "setInterval(()=>{},1000)");
  await f.jobs.close();
  const restored = await createBackgroundJobs(f.config);
  t.after(() => restored.close());
  assert.equal(
    restored.list().find((job) => job.id === alive.job.id).status,
    "interrupted",
  );
  assert.equal(
    restored.list().find((job) => job.id === cancelled.job.id).delivery,
    "suppressed",
  );
});

test("进程树取消会清理已脱离根进程的同组子进程", async (t) => {
  const f = await fixture(t);
  const target = join(f.directory, "descendant-completed");
  const childScript = `process.on("SIGTERM",()=>{});setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(target)},"bad"),3000)`;
  const started = await f.start(
    "tree",
    `require("child_process").spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:"ignore"});console.log("ready");setInterval(()=>{},1000)`,
  );
  await until(async () =>
    (await f.jobs.read("thread-a", started.job.id)).output.includes("ready"),
  );
  await delay(100);
  await f.jobs.tool({
    name: "background_cancel",
    threadId: "thread-a",
    args: { job_id: started.job.id },
  });
  await delay(3200);
  await assert.rejects(readFile(target), { code: "ENOENT" });
});

test("恢复时把未结束进程标记为中断、把发送中的完成通知标记为待核对", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.directory, "job-crash.json"),
    JSON.stringify({
      id: "crash",
      threadId: "thread-a",
      status: "running",
      delivery: "batched",
    }),
  );
  await writeFile(
    join(f.directory, "batch-crash.json"),
    JSON.stringify({
      id: "crash",
      threadId: "thread-a",
      jobIds: ["crash"],
      status: "sending",
    }),
  );
  const restored = await createBackgroundJobs(f.config);
  t.after(() => restored.close());
  assert.equal(restored.snapshot().jobs[0].status, "interrupted");
  assert.equal(restored.snapshot().batches[0].status, "uncertain");
});

test("模型读完结果与取消任务均能阻止准备中的通知重新投递", async (t) => {
  const f = await fixture(t);
  const first = await f.start("consumed", 'console.log("result")');
  await f.done(first.job.id);
  const batch = await f.jobs.claim("thread-a", "owner-a");
  assert.equal(await f.jobs.claim("thread-a", "owner-b"), null);
  await assert.rejects(
    f.jobs.updateBatch({ id: batch.id, status: "sending", owner: "owner-b" }),
    /另一服务/,
  );
  await f.jobs.tool({
    name: "background_read",
    threadId: "thread-a",
    args: { job_id: first.job.id },
  });
  const ignored = await f.jobs.updateBatch({
    id: batch.id,
    status: "sending",
    owner: "owner-a",
  });
  assert.equal(ignored.status, "suppressed");
  assert.equal(f.jobs.list()[0].delivery, "consumed");
  const second = await f.start("suppressed", 'console.log("result")');
  await f.done(second.job.id);
  const next = await f.jobs.claim("thread-a", "owner-a");
  await f.jobs.tool({
    name: "background_cancel",
    threadId: "thread-a",
    args: { job_id: second.job.id },
  });
  const stopped = await f.jobs.updateBatch({
    id: next.id,
    status: "sending",
    owner: "owner-a",
  });
  assert.equal(stopped.status, "suppressed");
});

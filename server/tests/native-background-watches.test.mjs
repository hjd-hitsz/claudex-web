import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBackgroundJobs } from "../../packages/background-terminal/background-jobs.mjs";
import { createNativeWatches } from "../../packages/background-terminal/native-watches.mjs";

test("订阅交接时退出的原生终端从对应项目历史结算且只登记一次", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claudex-native-watch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jobs = await createBackgroundJobs({ directory });
  const item = {
    type: "commandExecution",
    id: "native-call",
    processId: "4567",
    command: "npm test",
    cwd: directory,
    startedAtMs: 1000,
    status: "failed",
    exitCode: 23,
    completedAtMs: 2000,
    aggregatedOutput: "原生终端退出\n",
  };
  let closed = 0;
  const calls = [];
  const watches = createNativeWatches(
    "ws://127.0.0.1:8765",
    jobs,
    async () => ({
      async call(method, params) {
        calls.push([method, params]);
        if (method === "thread/resume") return { thread: { id: "thread" } };
        assert.equal(method, "thread/items/read");
        return { data: [{ turnId: "turn", item }] };
      },
      close() {
        closed++;
      },
    }),
  );
  t.after(() => watches.close());
  const handoff = { threadId: "thread", turnId: "turn", items: [item] };
  await Promise.all([watches.watch(handoff), watches.watch(handoff)]);
  assert.equal(closed, 1);
  assert.equal(
    calls.filter(([method]) => method === "thread/resume").length,
    1,
  );
  assert.deepEqual(calls[1], [
    "thread/items/read",
    { threadId: "thread", turnId: "turn", itemIds: ["native-call"] },
  ]);
  const [job] = jobs.list();
  assert.equal(jobs.list().length, 1);
  assert.equal(job.status, "failed");
  assert.equal(job.exitCode, 23);
  assert.equal(job.completedAt, 2000);
  assert.equal((await jobs.read("thread", job.id)).output, "原生终端退出\n");
  assert.deepEqual((await jobs.claim("thread", "owner")).jobIds, [job.id]);
});

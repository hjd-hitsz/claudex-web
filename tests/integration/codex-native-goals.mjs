import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { createCodexBackgroundActivity } from "../../server/src/backends/codex/background-activity.mjs";
import { createCodexConversationManager } from "../../server/src/backends/codex/conversation-manager.mjs";
import { observeCodexWork } from "../../server/src/backends/codex/native-activity.mjs";

// 隔离原生目录；暂停目标验证协议及持久化，不发起模型请求。
const root = await mkdtemp(join(tmpdir(), "codex-goals-"));
const home = join(root, "home");
await mkdir(home);
await writeFile(join(home, "config.toml"), "[features]\nthread_goals = true\n");
const child = spawn("codex", ["app-server", "--stdio"], {
  env: { ...process.env, CODEX_HOME: home },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.resume();
const pending = new Map(),
  events = [];
let sequence = 0;
const transport = { ready: true, call };
const conversations = createCodexConversationManager({
  transport,
  backgroundActivity: createCodexBackgroundActivity(transport),
  observeNativeWork: (threadId) => observeCodexWork(transport, threadId),
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method) {
    events.push(message);
    conversations.onEvent(message);
  }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
});
function call(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(method + " timeout"));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
try {
  await call("initialize", {
    clientInfo: { name: "claudex_goal_validation", version: "1.0" },
    capabilities: { experimentalApi: true },
  });
  const { thread } = await call("thread/start", {
    cwd: root,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    config: { thread_unload_delay_secs: 0 },
  });
  const threadId = thread.id;
  const activity = () => observeCodexWork({ call }, threadId);
  assert.equal((await call("thread/goal/get", { threadId })).goal, null);
  const result = await call("thread/goal/set", {
    threadId,
    objective: "验证目标持久化",
    status: "paused",
    origin: "user",
    tokenBudget: 5000,
  });
  assert.equal(result.goal.status, "paused");
  assert.deepEqual(await activity(), { activities: [], complete: true });
  assert.equal(
    (await call("thread/goal/get", { threadId })).goal.objective,
    "验证目标持久化",
  );
  await call("thread/goal/set", {
    threadId,
    objective: "修改后的目标",
    status: "paused",
    origin: "user",
  });
  assert.equal(
    (await call("thread/goal/get", { threadId })).goal.objective,
    "修改后的目标",
  );
  await call("thread/goal/clear", { threadId });
  assert.equal((await call("thread/goal/get", { threadId })).goal, null);
  assert(events.some((e) => e.method === "thread/goal/updated"));
  assert(events.some((e) => e.method === "thread/goal/cleared"));
  await call("thread/unsubscribe", { threadId });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (events.some((e) => e.method === "thread/closed")) break;
    await delay(10);
  }
  assert(events.some((e) => e.method === "thread/closed"));
  assert.equal((await call("thread/goal/get", { threadId })).goal, null);
  assert(!(await call("thread/loaded/list", {})).data.includes(threadId));
  const { queuedSubmission } = await call("thread/queue/add", {
    threadId,
    clientUserMessageId: "fixture-pending-input",
    input: [{ type: "text", text: "验证排队输入", text_elements: [] }],
  });
  assert.deepEqual(await activity(), {
    activities: ["queued"],
    complete: true,
  });
  assert.deepEqual(
    (await conversations.observeThreads()).threads.find(
      (entry) => entry.threadId === threadId,
    )?.activities,
    ["queued"],
  );
  await call("thread/queue/delete", {
    threadId,
    queuedSubmissionId: queuedSubmission.id,
  });
  assert.deepEqual(await activity(), { activities: [], complete: true });
  assert.equal(
    (await conversations.observeThreads()).threads.find(
      (entry) => entry.threadId === threadId,
    )?.activities,
    undefined,
  );
  assert(!events.some((e) => e.method === "turn/started"));
  console.log(
    execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
    "native goal create/edit/read/clear and queue activity enter/exit passed; model calls: 0",
  );
} finally {
  lines.close();
  child.kill();
  for (const request of pending.values()) clearTimeout(request.timer);
  await new Promise((resolve) => child.once("exit", resolve));
  await rm(root, { recursive: true, force: true });
}

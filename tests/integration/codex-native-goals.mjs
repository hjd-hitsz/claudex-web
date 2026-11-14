import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

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
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method) events.push(message);
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
  });
  const threadId = thread.id;
  assert.equal((await call("thread/goal/get", { threadId })).goal, null);
  const result = await call("thread/goal/set", {
    threadId,
    objective: "验证目标持久化",
    status: "paused",
    origin: "user",
    tokenBudget: 5000,
  });
  assert.equal(result.goal.status, "paused");
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
  assert(!events.some((e) => e.method === "turn/started"));
  console.log(
    execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
    "native goal create/edit/read/clear passed; model calls: 0",
  );
} finally {
  lines.close();
  child.kill();
  for (const request of pending.values()) clearTimeout(request.timer);
  await new Promise((resolve) => child.once("exit", resolve));
  await rm(root, { recursive: true, force: true });
}

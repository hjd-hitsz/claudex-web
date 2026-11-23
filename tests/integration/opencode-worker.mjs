import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { createOpenCodeWorkerAdapter } from "../../server/src/backends/opencode/worker-client.mjs";
import { runtimeDirectory } from "../../server/src/backends/opencode/installation.mjs";
import { workerLocation } from "../../server/src/backends/worker/worker-location.mjs";
import { messagesServer } from "../helpers/claude-messages-server.mjs";
const root = await mkdtemp(join(tmpdir(), "opencode-worker-"));
const cwd = join(root, "project");
await mkdir(cwd);
Object.assign(process.env, {
  XDG_DATA_HOME: join(root, "data"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  INVOCATION_ID: "00000000000000000000000000000001",
});
const bin = join(root, "bin");
await mkdir(bin);
for (const name of ["systemctl", "systemd-run"])
  await writeFile(join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
process.env.PATH = bin + delimiter + process.env.PATH;
const sdkRoot = resolve(
  process.env.OPENCODE_RUNTIME || ".cache/opencode/runtime",
);
await mkdir(join(root, "runtimes", "opencode"), { recursive: true });
await symlink(sdkRoot, runtimeDirectory(root));
const backend = {
  id: "opencode",
  type: "opencode",
  enabled: true,
  stateDir: join(root, "backends", "opencode"),
};
const config = {
  configDir: root,
  codexHome: join(root, "codex"),
  claudeHome: join(root, "claude"),
  upstreamUrl: "ws://127.0.0.1:1",
  backendsFile: join(root, "backends.json"),
  defaultCwd: cwd,
  projectlessRoot: join(root, "workspaces"),
};
let started = false;
const upstream = await messagesServer((input) => {
  if (!started && input.tools?.some((t) => t.name === "shell")) {
    started = true;
    return [
      {
        type: "tool_use",
        id: "tool_background",
        name: "shell",
        input: { command: "sleep 90", background: true, workdir: cwd },
      },
    ];
  }
  return [{ type: "text", text: "后台生命周期验证完成" }];
});
await writeFile(
  config.backendsFile,
  JSON.stringify({
    version: 1,
    backends: [
      { id: "codex", type: "codex", enabled: false },
      { id: "claude", type: "claude", enabled: false },
      backend,
    ],
    providers: [
      {
        id: "fixture",
        backendId: "claude",
        name: "Fixture",
        protocol: "messages",
        baseUrl: upstream.url,
        apiKey: "test-key",
        models: ["claude-sonnet-4-6"],
      },
    ],
  }),
  { mode: 0o600 },
);
const events = [];
const child = fork(
  new URL("../helpers/opencode-runtime-worker.mjs", import.meta.url),
  [],
  { stdio: ["ignore", "pipe", "pipe", "ipc"] },
);
child.on("message", (message) => events.push(message));
child.stderr.on("data", (data) => process.stderr.write(data));
async function until(check, description) {
  for (let n = 0; n < 1200; n++) {
    const error = events.find((e) => e.control === "error");
    if (error) throw new Error(error.message);
    if (await check()) return;
    await delay(25);
  }
  throw new Error(
    description + " timed out: " + JSON.stringify(events.slice(-3)),
  );
}
let adapter,
  pid,
  threadId,
  sequence = 0;
const call = (method, params) =>
  new Promise((resolve, reject) =>
    adapter.receive(
      {
        deliver(message) {
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        },
      },
      { id: ++sequence, method, params },
    ),
  );
try {
  child.send({
    backend,
    config,
    cwd,
    model: "claudex-fixture/claude-sonnet-4-6",
  });
  await until(() => events.some((e) => e.control === "connected"), "connect");
  ({ pid, threadId } = events.find((e) => e.control === "connected"));
  await until(
    () =>
      events.some(
        (e) => e.method === "turn/completed" && e.params.threadId === threadId,
      ),
    "initial turn",
  );
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.doesNotThrow(() => process.kill(pid, 0));
  adapter = createOpenCodeWorkerAdapter({
    backend,
    config,
    broadcast: (e) => events.push(e),
    send: (c, m) => c.deliver(m),
  });
  await adapter.connect();
  assert.equal(adapter.workerPid, pid);
  const tasks = (await call("thread/backgroundTasks/list", { threadId })).tasks;
  const task = tasks.find((t) => t.status === "running" && t.kind === "shell");
  assert.ok(task, "shell survives bridge SIGKILL");
  await assert.rejects(adapter.shutdown(), { code: "EWORKERBUSY" });
  await call("thread/backgroundTasks/cancel", { threadId, taskId: task.id });
  await until(
    async () =>
      !(await call("thread/backgroundTasks/list", { threadId })).tasks.some(
        (t) => t.status === "running",
      ) && !adapter.state().params.activeTurns[threadId],
    "cancel and resume",
  );
  const after = events.length;
  const result = await call("turn/start", {
    threadId,
    input: [{ type: "text", text: "验证重连后的同一原生历史" }],
  });
  await until(
    () =>
      events
        .slice(after)
        .some(
          (e) =>
            e.method === "turn/completed" &&
            e.params.turn.id === (result.turn?.id || result.turnId),
        ),
    "resume history",
  );
  const { thread } = await call("thread/read", {
    threadId,
    includeTurns: true,
  });
  assert.ok(thread.turns.length >= 2);
  const location = workerLocation(backend);
  assert.equal((await stat(location.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(location.socket)).mode & 0o777, 0o600);
  await until(() => !adapter.state().params.activeTurns[threadId], "idle");
  await adapter.shutdown();
  adapter.close();
  adapter = createOpenCodeWorkerAdapter({
    backend,
    config,
    broadcast: (e) => events.push(e),
    send: (c, m) => c.deliver(m),
  });
  await adapter.connect();
  assert.notEqual(adapter.workerPid, pid);
  pid = adapter.workerPid;
  const restored = (await call("thread/read", { threadId, includeTurns: true }))
    .thread;
  assert.deepEqual(restored.turns, thread.turns);
  await adapter.shutdown();
  console.log(
    "OpenCode 普通进程验证通过：桥接 SIGKILL、同一执行 PID 与后台任务保留、忙时停止拒绝、单任务停止、执行进程重启后的原生历史恢复和空闲退出",
  );
} finally {
  child.kill("SIGKILL");
  if (adapter) {
    await adapter.shutdown().catch(() => {});
    adapter.close();
  }
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await upstream.close();
  await rm(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readConfig } from "../../server/src/config.mjs";
import { createBackendConfiguration } from "../../server/src/backends/configuration.mjs";
import { createBackendManager } from "../../server/src/backends/manager.mjs";
import { createClaudeWorkerAdapter } from "../../server/src/backends/claude/worker-client.mjs";
import { messagesServer } from "../helpers/claude-messages-server.mjs";

const root = await mkdtemp(join(tmpdir(), "claude-subagent-save-"));
const cwd = join(root, "workspace");
await mkdir(cwd);
const config = readConfig({
  CLAUDEX_WEB_CONFIG_DIR: root,
  CODEX_HOME: join(root, "codex"),
  CLAUDE_CONFIG_DIR: join(root, "native"),
  DEFAULT_CWD: cwd,
});
let round = 0;
let issued = false;
const secondary = await messagesServer(() => [
  { type: "text", text: "CHILD_COMPLETE" },
]);
const primary = await messagesServer((body) => {
  if (!issued && body.tools?.some((tool) => tool.name === "Agent")) {
    issued = true;
    return [
      {
        type: "tool_use",
        id: `child-${round}`,
        name: "Agent",
        input: {
          subagent_type: "general-purpose",
          description: "Verify default model",
          prompt: `CHILD_${round}: return proof.`,
        },
      },
    ];
  }
  return [{ type: "text", text: "PARENT_COMPLETE" }];
});
await writeFile(
  config.backendsFile,
  JSON.stringify({
    backends: [
      { id: "codex", type: "codex", enabled: false },
      { id: "claude", type: "claude", enabled: true },
    ],
    providers: [
      {
        id: "primary",
        backendId: "claude",
        name: "Primary",
        protocol: "messages",
        baseUrl: primary.url,
        apiKey: "primary-key",
        models: ["parent"],
        modelCapabilities: {
          parent: { supportedEffortLevels: ["low", "high"] },
        },
      },
      {
        id: "secondary",
        backendId: "claude",
        name: "Secondary",
        protocol: "messages",
        baseUrl: secondary.url,
        apiKey: "secondary-key",
        models: ["first-child", "next-child"],
        modelCapabilities: Object.fromEntries(
          ["first-child", "next-child"].map((model) => [
            model,
            { supportedEffortLevels: ["low", "high"] },
          ]),
        ),
      },
    ],
  }),
  { mode: 0o600 },
);
const configuration = createBackendConfiguration(config);
const events = [];
const manager = createBackendManager({
  config,
  version: { displayVersion: "test" },
  send: (client, message) => client.deliver(message),
  broadcast: (event) => events.push(event),
  factories: { installation: { state: () => ({}) } },
});
let observer;
let sequence = 0;
const call = (method, params) =>
  new Promise((resolve, reject) => {
    manager
      .receive(
        {
          readyState: 1,
          deliver: (message) =>
            message.error
              ? reject(new Error(message.error.message))
              : resolve(message.result),
        },
        { id: ++sequence, method, params },
      )
      .catch(reject);
  });
async function observe() {
  const backend = (await configuration.read()).backends.find(
    (b) => b.id === "claude",
  );
  observer = createClaudeWorkerAdapter({
    backend,
    config,
    send() {},
    broadcast() {},
  });
  await observer.connect();
  return observer.workerPid;
}
const timings = [];
try {
  await manager.connect();
  const workerPid = await observe();
  const { thread } = await call("thread/start", {
    backendId: "claude",
    cwd,
    providerId: "primary",
    model: "parent",
  });
  let nativePid;
  for (const [model, effort] of [
    ["first-child", "high"],
    ["next-child", "low"],
    ["", ""],
  ]) {
    const start = performance.now();
    await call("lan/backends/save", {
      id: "claude",
      type: "claude",
      subagentModel: model,
      subagentProviderId: model ? "secondary" : "",
      subagentEffort: effort,
    });
    timings.push({ model, ms: Math.round(performance.now() - start) });
    observer.close();
    assert.equal(await observe(), workerPid, "保存和桥接重连保留执行服务 PID");
    issued = false;
    round++;
    const before = secondary.requests.length;
    const { turn } = await call("turn/start", {
      threadId: thread.id,
      model: "parent",
      providerId: "primary",
      effort: "low",
      input: [
        { type: "text", text: `PARENT_${round}: delegate a proof task.` },
      ],
    });
    let completed;
    for (let i = 0; i < 2000; i++) {
      completed = events.find(
        (event) =>
          event.method === "turn/completed" && event.params.turn.id === turn.id,
      );
      if (completed) break;
      await delay(25);
    }
    assert.equal(
      completed?.params.turn.status,
      "completed",
      JSON.stringify(completed),
    );
    assert.equal(issued, true);
    if (model) {
      assert.ok(secondary.requests.length > before);
      for (const request of secondary.requests.slice(before)) {
        assert.equal(request.model, model);
        assert.equal(request.output_config.effort, effort);
      }
    } else assert.equal(secondary.requests.length, before);
    const backend = (await configuration.read()).backends.find(
      (b) => b.id === "claude",
    );
    const index = JSON.parse(
      await readFile(join(backend.stateDir, "claudex-web-index.json"), "utf8"),
    );
    const pid =
      index.sessions[thread.id.replace("backend:claude:", "")].nativeProcess
        .pid;
    if (nativePid === undefined) nativePid = pid;
    else assert.equal(pid, nativePid, "模型、强度及清空操作保持原生主会话 PID");
  }
  console.log(
    JSON.stringify({
      nativeCLI: true,
      workerPid,
      nativePid,
      rounds: round,
      timings,
      checks: [
        "save",
        "worker reconnect",
        "new model and effort",
        "clear defaults",
        "same native process",
      ],
    }),
  );
} finally {
  if (observer) {
    try {
      await observer.shutdown();
    } finally {
      observer.close();
    }
  }
  await manager.close();
  await primary.close();
  await secondary.close();
  await rm(root, { recursive: true, force: true });
}

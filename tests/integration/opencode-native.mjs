import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { messagesServer } from "../helpers/claude-messages-server.mjs";
import { createOpenCodeAdapter } from "../../server/src/backends/opencode/adapter.mjs";
import { loadOpenCode } from "../../server/src/backends/opencode/runtime.mjs";

const entry = process.env.OPENCODE_SDK_ENTRY;
assert.ok(entry, "OPENCODE_SDK_ENTRY must identify the installed SDK entry");
const root = await mkdtemp(join(tmpdir(), "claudex-opencode-native-"));
Object.assign(process.env, {
  XDG_DATA_HOME: join(root, "data"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
});
const workspaceTools = process.env.OPENCODE_WORKSPACE_TOOLS === "1";
const OpenCode = await loadOpenCode(resolve(entry), { workspaceTools });
const shell = workspaceTools ? "claudex_shell" : "shell";
const command =
  "printf native > tool-output.txt; while [ ! -f .finish-fixture ]; do sleep 0.05; done; printf 'fixture finished\\n'";
const evidence = `.cache/opencode/${workspaceTools ? "optimized" : "native"}`;
const events = [];
const bus = new EventEmitter();
const provider = {
  id: "fixture",
  name: "Fixture",
  models: ["claude-sonnet-4-6"],
  modelAliases: { "claude-sonnet-4-6": "Fixture model" },
  apiKey: "isolated-test-key",
};
let step = 0,
  scenario = "tools",
  goalStep = 0;
const upstream = await messagesServer(async (input) => {
  if (JSON.stringify(input).includes("<template>"))
    return [
      {
        type: "text",
        text: "## Objective\n- 验证 OpenCode 原生生命周期。\n\n## Requirements\n- 隔离目录。\n\n## Decisions\n- 使用原生 SDK。\n\n## Work State\n### Completed\n- 工具、计划和目标验证。\n### Active\n- 上下文整理。\n### Blocked\n- (none)\n\n## Next Move\n1. 核对整理结果。\n\n## Relevant Files\n- (none)\n\n## Important Context\n- (none)",
      },
    ];
  if (!input.tools?.length) return [{ type: "text", text: "隔离测试标题" }];
  await mkdir(".cache/opencode", { recursive: true });
  await writeFile(
    `${evidence}-tools.json`,
    JSON.stringify(input.tools, null, 2),
  );
  if (scenario === "complete" && goalStep++ === 0)
    return [
      {
        type: "tool_use",
        id: "tool_goal_complete",
        name: "claudex_goal_status",
        input: { status: "complete", reason: "已核对隔离验证目标" },
      },
    ];
  if (scenario !== "tools")
    return [{ type: "text", text: "OpenCode 目标与计划验证" }];
  if (step++ === 0)
    return [
      {
        type: "tool_use",
        id: "tool_native_shell",
        name: shell,
        input: {
          command,
          workdir: root,
        },
      },
    ];
  if (step === 2)
    return [
      {
        type: "tool_use",
        id: "tool_native_question",
        name: "question",
        input: {
          questions: [
            {
              header: "验收",
              question: "是否继续？",
              options: [{ label: "继续", description: "完成原生回归" }],
            },
          ],
        },
      },
    ];
  return [{ type: "text", text: "OpenCode 原生执行验证完成" }];
});
provider.baseUrl = upstream.url;
let adapter, nativeHost;
const broadcast = (event) => {
  events.push(event);
  bus.emit("event", event);
};
const create = () =>
  createOpenCodeAdapter({
    backend: {
      id: "opencode",
      type: "opencode",
      workspaceTools,
      stateDir: join(root, "bridge-state"),
    },
    config: {
      configDir: join(root, "web"),
      defaultCwd: root,
      projectlessRoot: join(root, "workspaces"),
    },
    providers: { list: async () => [provider], get: async () => provider },
    send: (client, message) => client.deliver(message),
    broadcast,
    createHost: async (options) =>
      (nativeHost = await OpenCode.create({
        ...options,
        database: { path: join(root, "opencode.db") },
        config: {
          ...options.config,
          claude: false,
          directory: join(root, "config"),
        },
        models: { fetch: false },
        fs: { filewatcher: false },
      })),
  });
async function call(method, params = {}) {
  let response;
  await adapter.receive(
    {
      deliver: (value) => {
        response = value;
      },
    },
    { id: method, method, params },
  );
  if (response?.error) throw new Error(method + ": " + response.error.message);
  assert.ok(response, method + " responds");
  return response.result;
}
function waitFor(predicate, timeout = 30000, after = 0) {
  const old = events.slice(after).find(predicate);
  if (old) return Promise.resolve(old);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bus.off("event", listen);
      reject(
        new Error(
          "Native event timed out in " +
            scenario +
            "; latest events: " +
            JSON.stringify(events.slice(-8)) +
            "; latest state: " +
            JSON.stringify(adapter.state()),
        ),
      );
    }, timeout);
    const listen = (event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      bus.off("event", listen);
      resolve(event);
    };
    bus.on("event", listen);
  });
}
try {
  await writeFile(
    join(root, "AGENTS.md"),
    "Every response must respect OPENCODE_ISOLATED_PROJECT_MARKER.\n",
  );
  adapter = create();
  await adapter.connect();
  assert.equal(adapter.ready, true);
  const catalogue = await call("model/list", { cwd: root });
  const model = catalogue.data.find(
    (m) => m.model === "claudex-fixture/claude-sonnet-4-6",
  );
  assert.ok(model);
  assert.equal(model.displayName, "Fixture model");
  const { thread } = await call("thread/start", {
    cwd: root,
    model: model.model,
  });
  await nativeHost.sessions.update({
    sessionID: thread.id,
    permissions: [{ action: "fixture.approve", resource: "*", effect: "ask" }],
  });
  await nativeHost.permission.create({
    sessionID: thread.id,
    action: "fixture.approve",
    resources: ["isolated-test"],
  });
  const permission = await waitFor(
    (e) =>
      e.method === "item/tool/requestUserInput" &&
      e.params.questions[0]?.id === "decision",
  );
  await adapter.receive(
    {},
    {
      id: permission.id,
      result: { answers: { decision: { answers: ["允许本次"] } } },
    },
  );
  await waitFor(
    (e) =>
      e.method === "serverRequest/resolved" &&
      e.params.requestId === permission.id,
  );
  assert.deepEqual(
    await nativeHost.permission.list({ sessionID: thread.id }),
    [],
  );
  const { turn } = await call("turn/start", {
    threadId: thread.id,
    model: model.model,
    input: [{ type: "text", text: "请验证当前项目指令并回答。" }],
  });
  const running = await waitFor(
    (e) =>
      e.method === "item/started" && e.params.item?.id === "tool_native_shell",
  );
  assert.equal(running.params.item.type, "commandExecution");
  assert.equal(running.params.item.command, command);
  assert.equal(running.params.item.cwd, root);
  assert.equal(running.params.item.status, "inProgress");
  assert.equal(running.params.item.aggregatedOutput, "");
  const additional = await call("turn/steer", {
    threadId: thread.id,
    input: [{ type: "text", text: "保留这条补充输入" }],
  });
  const cancelled = await call("turn/steer", {
    threadId: thread.id,
    input: [{ type: "text", text: "取消这条补充输入" }],
  });
  assert.ok(additional.inputId);
  assert.ok(
    (await call("lan/inputQueue/list", { threadId: thread.id })).entries.some(
      (i) => i.id === cancelled.inputId,
    ),
  );
  await call("lan/inputQueue/cancel", {
    threadId: thread.id,
    id: cancelled.inputId,
  });
  await writeFile(join(root, ".finish-fixture"), "");
  const question = await waitFor(
    (e) =>
      e.method === "item/tool/requestUserInput" &&
      e.params.questions[0]?.id !== "decision",
  );
  await adapter.receive(
    {},
    { id: question.id, result: { answers: { q0: { answers: ["继续"] } } } },
  );
  const ended = await waitFor(
    (e) => e.method === "turn/completed" && e.params.threadId === thread.id,
  );
  assert.equal(ended.params.turn.id, turn.id);
  assert.equal(ended.params.turn.status, "completed");
  const history = await call("thread/read", {
    threadId: thread.id,
    includeTurns: true,
  });
  const savedCommand = history.thread.turns
    .flatMap((t) => t.items)
    .find((item) => item.id === running.params.item.id);
  assert.equal(savedCommand.command, command);
  assert.equal(savedCommand.status, "completed");
  assert.equal(savedCommand.exitCode, 0);
  assert.equal(savedCommand.aggregatedOutput, "fixture finished\n");
  assert.ok(
    history.thread.turns
      .flatMap((t) => t.items)
      .some((i) => i.text === "OpenCode 原生执行验证完成"),
  );
  assert.ok(
    upstream.requests.some((r) =>
      JSON.stringify(r.system).includes("OPENCODE_ISOLATED_PROJECT_MARKER"),
    ),
  );
  assert.ok(events.some((e) => e.method === "item/agentMessage/delta"));
  assert.equal(await readFile(join(root, "tool-output.txt"), "utf8"), "native");
  const texts = history.thread.turns
    .flatMap((t) => t.items)
    .filter((i) => i.type === "userMessage")
    .flatMap((i) => i.content)
    .map((i) => i.text);
  assert.ok(texts.includes("保留这条补充输入"));
  assert.ok(!texts.includes("取消这条补充输入"));
  const fork = await call("thread/fork", { threadId: thread.id });
  assert.notEqual(fork.thread.id, thread.id);
  await call("thread/revert", { threadId: thread.id, beforeTurnId: turn.id });
  assert.equal(
    (await call("thread/read", { threadId: thread.id, includeTurns: true }))
      .thread.turns.length,
    0,
  );
  assert.ok(
    (
      await call("thread/read", {
        threadId: fork.thread.id,
        includeTurns: true,
      })
    ).thread.turns.length,
  );
  await adapter.close();
  adapter = create();
  await adapter.connect();
  assert.equal(
    (await call("thread/read", { threadId: thread.id, includeTurns: true }))
      .thread.turns.length,
    0,
  );
  scenario = "complete";
  let after = events.length;
  await call("thread/goal/set", {
    threadId: thread.id,
    objective: "完成原生目标隔离验证",
  });
  await waitFor(
    (e) =>
      e.method === "thread/goal/updated" &&
      e.params.goal?.status === "completed",
    30000,
    after,
  );
  await waitFor(
    (e) => e.method === "turn/completed" && e.params.threadId === thread.id,
    30000,
    after,
  );
  assert.equal(
    (await call("thread/goal/get", { threadId: thread.id })).goal.status,
    "completed",
  );
  await call("thread/goal/clear", { threadId: thread.id });
  scenario = "budget";
  after = events.length;
  await call("thread/goal/set", {
    threadId: thread.id,
    objective: "验证预算停止",
    tokenBudget: 100,
  });
  await waitFor(
    (e) =>
      e.method === "thread/goal/updated" &&
      e.params.goal?.status === "budgetLimited",
    30000,
    after,
  );
  await waitFor(
    (e) => e.method === "turn/completed" && e.params.threadId === thread.id,
    30000,
    after,
  );
  await call("thread/goal/clear", { threadId: thread.id });
  scenario = "plan";
  after = events.length;
  await call("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "只读调查并提出计划" }],
    collaborationMode: { mode: "plan" },
  });
  await waitFor(
    (e) => e.method === "turn/completed" && e.params.threadId === thread.id,
    30000,
    after,
  );
  assert.ok(
    (
      await call("thread/read", { threadId: thread.id, includeTurns: true })
    ).thread.turns
      .at(-1)
      .items.some((i) => i.type === "plan"),
  );
  after = events.length;
  await call("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "批准并执行计划" }],
    collaborationMode: { mode: "default" },
  });
  await waitFor(
    (e) => e.method === "turn/completed" && e.params.threadId === thread.id,
    30000,
    after,
  );
  assert.ok(
    (
      await call("thread/read", { threadId: thread.id, includeTurns: true })
    ).thread.turns
      .at(-1)
      .items.some((i) => i.type === "agentMessage"),
  );
  after = events.length;
  await call("thread/compact/start", { threadId: thread.id });
  await waitFor(
    (e) =>
      e.method === "lan/compaction" &&
      ["completed", "failed"].includes(e.params.compaction.status),
    30000,
    after,
  );
  assert.equal(
    adapter.state().params.compactions[thread.id].status,
    "completed",
  );
  await mkdir(".cache/opencode", { recursive: true });
  await writeFile(`${evidence}-events.json`, JSON.stringify(events, null, 2));
  console.log(
    JSON.stringify({
      sdk: "2.3.2",
      requests: upstream.requests.length,
      tools: upstream.requests
        .find((r) => r.tools?.length)
        ?.tools?.map((t) => t.name),
      result: "passed",
    }),
  );
} finally {
  await writeFile(
    `${evidence}-last-events.json`,
    JSON.stringify(events, null, 2),
  );
  await writeFile(join(root, ".finish-fixture"), "");
  await adapter?.close();
  await upstream.close();
  await rm(root, { recursive: true, force: true });
}

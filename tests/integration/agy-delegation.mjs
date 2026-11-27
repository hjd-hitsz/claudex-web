import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createBackendConfiguration } from "../../server/src/backends/configuration.mjs";
import { createAgyWorkerAdapter } from "../../server/src/backends/agy/worker-client.mjs";
import { workerLocation } from "../../server/src/backends/agy/worker-ipc.mjs";
import { shutdownBrowserClaudeWorker } from "../helpers/claude-worker-cleanup.mjs";
import { messagesServer } from "../helpers/claude-messages-server.mjs";
import { taskRequest } from "../../packages/background-terminal/client.mjs";
import { traceId } from "../../server/src/backends/delegation/trace-ids.mjs";
import { createDelegationActivity } from "../../server/src/backends/delegation/activity.mjs";
import { createActivitySource } from "../../server/src/conversation-manager/activity.mjs";
import { mapState } from "../../server/src/backends/identity-mapping.mjs";
import { resourceId } from "../../shared/backend-identity.mjs";

const root = await mkdtemp(join(tmpdir(), "claudex-agy-delegation-"));
const cwd = join(root, "workspace");
const codexHome = join(root, "codex");
const claudeHome = join(root, "claude");
const bin = join(root, "bin");
await Promise.all([cwd, codexHome, claudeHome, bin].map((path) => mkdir(path)));
const fixture = fileURLToPath(
  new URL("../helpers/agy-fixture-cli.mjs", import.meta.url),
);
await writeFile(
  join(bin, "agy"),
  `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
  { mode: 0o700 },
);
await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });

const reserve = createServer();
reserve.listen(0, "127.0.0.1");
await once(reserve, "listening");
const address = "ws://127.0.0.1:" + reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const config = {
  defaultCwd: cwd,
  configDir: root,
  codexHome,
  claudeHome,
  backendsFile: join(root, "backends.json"),
  projectlessRoot: join(root, "projects"),
  upstreamUrl: address,
  backgroundTaskDir: join(root, "background-terminal"),
};
const oldPath = process.env.PATH;
const oldRuntime = process.env.XDG_RUNTIME_DIR;
const oldEndpoint = process.env.ANTHROPIC_BASE_URL;
const oldKey = process.env.ANTHROPIC_API_KEY;
const oldAuth = process.env.ANTHROPIC_AUTH_TOKEN;
process.env.PATH = bin + ":" + oldPath;
process.env.XDG_RUNTIME_DIR = root;
delete process.env.ANTHROPIC_AUTH_TOKEN;
process.env.ANTHROPIC_API_KEY = "fixture";
const configStore = createBackendConfiguration(config);
await configStore.save({ id: "codex", type: "codex", enabled: true });
await configStore.save({ id: "claude", type: "claude", enabled: true });
const backend = await configStore.save({
  id: "agy",
  type: "agy",
  enabled: true,
  delegates: {
    codex: { enabled: true, model: "gpt-5.4", effort: "low" },
    claude: { enabled: true, model: "claude-sonnet-4-6" },
  },
});
let codexCalls = 0;
let modelRequests = 0;
const executorPrompts = { codex: [], claude: [] };
let nativeErrors = "";
const backgroundCommand = (backend, number) =>
  `while [ ! -e ${backend}-release-${number} ]; do sleep .1; done; printf ${backend}-done-${number}`;
let codexBackgroundCalls = 0;
let claudeBackgroundCalls = 0;
const takeovers = Object.fromEntries(
  ["codex", "claude"].map((target) => [
    target,
    { release: Promise.withResolvers() },
  ]),
);
const lastWake = Object.fromEntries(
  ["codex", "claude"].map((target) => [
    target,
    { release: Promise.withResolvers() },
  ]),
);
const gate = Promise.withResolvers();
const codex = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (request.url !== "/v1/responses") return response.writeHead(404).end();
  const body = JSON.parse(raw);
  modelRequests++;
  if (!JSON.stringify(body.input).includes("[Claudex delegation step:"))
    return response.writeHead(500).end();
  const title = body.text?.format?.type === "json_schema";
  const prompt = JSON.stringify(body.input);
  if (!title) executorPrompts.codex.push(prompt);
  const replaced = !title && prompt.includes("AGY_REPLACE");
  const takeover = !title && prompt.includes("AGY_TAKEOVER_RUNNING");
  const background =
    !title && JSON.stringify(body.input).includes("AGY_BACKGROUND_TEST");
  const n = title
    ? modelRequests
    : background
      ? ++codexBackgroundCalls
      : takeover || replaced
        ? 0
        : ++codexCalls;
  if (!title && !background && n === 1) await gate.promise;
  if (takeover && !replaced) {
    takeovers.codex.entered = true;
    await takeovers.codex.release.promise;
  }
  if (background && n === 5) {
    lastWake.codex.entered = true;
    await lastWake.codex.release.promise;
  }
  const id = "fixture-" + modelRequests;
  const answer = title
    ? JSON.stringify({ title: "委派测试" })
    : background
      ? "CODEX_STAGE_" + n
      : replaced
        ? "CODEX_REPLACEMENT_RESULT"
        : takeover
          ? "STALE_RESULT"
          : n === 1
            ? "FIXTURE_FOLLOWUP"
            : "FIXTURE_WRITE";
  let item = {
    id: "message-" + modelRequests,
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: answer }],
  };
  if (background && n <= 2) {
    const tool = body.tools
      .flatMap(
        (entry) =>
          entry.tools?.map((child) => ({
            ...child,
            namespace: entry.name,
          })) || [entry],
      )
      .find(({ name }) => name === "background_start");
    assert(tool, "Codex 原生请求含后台 MCP");
    item = {
      type: "function_call",
      name: tool.name,
      namespace: tool.namespace,
      call_id: "agy-background-" + n,
      arguments: JSON.stringify({
        command: backgroundCommand("codex", n),
        title: "Codex terminal " + n,
        check_after_ms: 300_000,
      }),
    };
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    [
      { type: "response.created", response: { id } },
      {
        type: "response.output_item.done",
        item,
      },
      {
        type: "response.completed",
        response: {
          id,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ]
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
  );
});
codex.listen(0, "127.0.0.1");
await once(codex, "listening");
let asked = false;
const provider = await messagesServer(async (body) => {
  const prompt = JSON.stringify(body.messages);
  executorPrompts.claude.push(prompt);
  const asks = body.tools?.some(({ name }) => name === "AskUserQuestion");
  if (asks && prompt.includes("AGY_REPLACE"))
    return [{ type: "text", text: "CLAUDE_REPLACEMENT_RESULT" }];
  if (asks && prompt.includes("AGY_TAKEOVER_RUNNING")) {
    takeovers.claude.entered = true;
    await takeovers.claude.release.promise;
    return [{ type: "text", text: "STALE_RESULT" }];
  }
  if (
    body.tools?.some(({ name }) => name === "Bash") &&
    JSON.stringify(body.messages).includes("AGY_BACKGROUND_TEST")
  ) {
    const n = ++claudeBackgroundCalls;
    if (n <= 2)
      return [
        {
          type: "tool_use",
          id: "toolu_agy_background_" + n,
          name: "Bash",
          input: {
            command: backgroundCommand("claude", n),
            description: "Claude terminal " + n,
            run_in_background: true,
          },
        },
      ];
    if (n === 5) {
      lastWake.claude.entered = true;
      await lastWake.claude.release.promise;
    }
    return [{ type: "text", text: "CLAUDE_STAGE_" + n }];
  }
  if (asks && (!asked || prompt.includes("AGY_TAKEOVER_APPROVAL"))) {
    asked = true;
    return [
      {
        type: "tool_use",
        id: "toolu_agy_selection",
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              header: "核对范围",
              question: "是否已确认核对范围？",
              multiSelect: false,
              options: [
                { label: "确认", description: "继续核对" },
                { label: "调整", description: "修改范围" },
              ],
            },
          ],
        },
      },
    ];
  }
  return [{ type: "text", text: "CLAUDE_NATIVE_RESULT" }];
});
process.env.ANTHROPIC_BASE_URL = provider.url;
await writeFile(
  join(codexHome, "config.toml"),
  `
model = "gpt-5.4"
model_provider = "fixture"
[model_providers.fixture]
name = "fixture"
base_url = "http://127.0.0.1:${codex.address().port}/v1"
wire_api = "responses"
`,
);
const native = spawn("codex", ["app-server", "--listen", address], {
  env: { ...process.env, CODEX_HOME: codexHome },
  cwd,
  stdio: ["ignore", "ignore", "pipe"],
});
const backgroundWorker = spawn(
  process.execPath,
  [
    new URL("../../packages/background-terminal/cli.mjs", import.meta.url)
      .pathname,
    "serve",
    config.backgroundTaskDir,
    address,
  ],
  { stdio: "ignore" },
);
native.stderr.on("data", (chunk) => {
  nativeErrors = (nativeErrors + chunk).slice(-6000);
});
const events = [];
const replies = new Map();
function connect() {
  return createAgyWorkerAdapter({
    backend,
    config,
    version: { displayVersion: "fixture" },
    send: (_client, message) => replies.get(message.id)?.(message),
    broadcast: (message) => events.push(message),
  });
}
async function until(read, title, timeout = 25000) {
  for (const start = Date.now(); Date.now() - start < timeout;) {
    const value = await read();
    if (value) return value;
    await delay(90);
  }
  throw new Error("验证超时：" + title);
}
let worker = connect();
async function rpc(method, params = {}) {
  let reply;
  const id = randomUUID();
  replies.set(id, (value) => {
    reply = value;
  });
  try {
    await worker.receive({}, { id, method, params });
    if (reply.error) throw new Error(reply.error.message);
    return reply.result;
  } finally {
    replies.delete(id);
  }
}
const saved = async () =>
  JSON.parse(await readFile(join(backend.stateDir, "state.json"), "utf8"));

try {
  await until(
    () =>
      taskRequest(config.backgroundTaskDir, "health", {
        expectedUpstream: new URL(address).href,
      }).catch(() => null),
    "独立后台任务服务启动",
  );
  await worker.connect();
  assert(worker.ready, worker.state().params.error);
  assert.equal((await rpc("model/list")).data[0].model, "fixture-gemini");
  const { thread } = await rpc("thread/start", { cwd });
  await assert.rejects(
    rpc("turn/start", {
      threadId: thread.id,
      collaborationMode: { mode: "plan" },
    }),
    /秘书模式/,
  );
  const direct = await rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "AGY_SECRETARY_ONLY 你直接总结已有结论。" }],
    delegateTo: "codex",
  });
  await until(
    () =>
      events.some(
        ({ method, params }) =>
          method === "turn/completed" && params.turn.id === direct.turn.id,
      ),
    "已有结论由秘书直接答复",
  );
  assert.deepEqual(Object.keys((await saved()).tasks), []);
  assert.equal(codexCalls, 0);
  const secretaryMessage =
    "核对代码里的行为。你负责写文档，SECRETARY_WRITING_ONLY。";
  const first = await rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: secretaryMessage }],
    delegateTo: "codex",
  });
  const task = await until(
    async () => Object.values((await saved()).tasks)[0],
    "Codex 持久受理",
  );
  await until(() => codexCalls === 1, "Codex 原生模型请求");
  assert.match(executorPrompts.codex[0], /检查并报告具体证据/);
  assert.doesNotMatch(executorPrompts.codex[0], /SECRETARY_WRITING_ONLY/);
  assert.deepEqual(task.original, []);
  assert.deepEqual(task.steps[0].original, []);
  const secretaryTurn = (await saved()).sessions[thread.id].turns.find(
    ({ id }) => id === first.turn.id,
  );
  assert.equal(secretaryTurn.items[0].content[0].text, secretaryMessage);
  await until(
    () =>
      events.some(
        ({ method, params }) =>
          method === "turn/completed" && params.turn.id === first.turn.id,
      ),
    "原 agy 结束轮次",
  );
  assert.equal(Object.keys((await saved()).tasks).length, 1);
  const delegationActivity = createDelegationActivity(root, () => true);
  assert.deepEqual(await delegationActivity(), [
    { threadId: "backend:agy:" + thread.id, sourceRuntime: undefined },
  ]);
  worker.close();
  gate.resolve();
  worker = connect();
  await worker.connect();
  await until(
    async () =>
      (await readFile(join(cwd, "report.md"), "utf8").catch(() => "")).includes(
        "已核对",
      ),
    "秘书文档写入",
  );
  const after = (await saved()).tasks[task.id];
  await until(
    async () => !(await delegationActivity()).length,
    "agy 结果回投结算后退出活动状态",
  );
  console.log("agy 主会话在专家执行期间保持委派活动，重连并回投结算后退出");
  assert.equal(worker.state().params.questions?.length, 0);
  const delegated = await rpc("thread/read", {
    threadId: "delegation/" + task.id,
    includeTurns: true,
  });
  assert.equal(delegated.thread.id, "delegation/" + task.id);
  assert(
    delegated.thread.turns
      .flatMap(({ items }) => items)
      .some(({ text }) => text === "FIXTURE_WRITE"),
  );
  assert.equal(after.steps.length, 2);
  assert.equal(after.steps[1].result.answer, "FIXTURE_WRITE");
  assert.equal(codexCalls, 2);
  await until(
    () => !worker.state().params.activeTurns?.[thread.id],
    "秘书结束写作",
  );
  const older = await rpc("thread/items/list", {
    threadId: thread.id,
    sortDirection: "asc",
    limit: 200,
  });
  assert(older.data.some(({ item }) => item.type === "subAgentActivity"));
  const written = older.data.find(({ item }) => item.type === "fileChange");
  assert(written, "ACP 文件差异投影");
  await rpc("lan/files/undo", {
    threadId: thread.id,
    turnId: written.turnId,
    path: join(cwd, "report.md"),
  });
  await assert.rejects(readFile(join(cwd, "report.md")), { code: "ENOENT" });
  const { data: originalTurns } = await rpc("thread/turns/list", {
    threadId: thread.id,
  });
  const boundary = originalTurns.at(-1).id;
  await rpc("thread/compact/start", { threadId: thread.id });
  await until(
    async () =>
      (await rpc("lan/compaction/check", { threadId: thread.id })).compaction
        ?.commandFinished,
    "整理命令回执",
  );
  assert(
    events.some(
      ({ method, params }) =>
        method === "lan/compaction" && params.compaction?.commandFinished,
    ),
  );
  const { thread: branch } = await rpc("thread/fork", {
    threadId: thread.id,
    lastTurnId: boundary,
  });
  assert.equal(branch.parentThreadId, thread.id);
  assert.equal((await saved()).sessions[branch.id].source.turnId, boundary);
  await rpc("thread/archive", { threadId: thread.id });
  assert.equal(
    (await rpc("thread/list", { archived: true })).data[0].id,
    thread.id,
  );
  await rpc("thread/unarchive", { threadId: thread.id });
  await rpc("thread/delete", { threadId: branch.id });

  await rpc("turn/start", {
    threadId: thread.id,
    input: [
      {
        type: "text",
        text: "Claude 调查。你负责说明，SECRETARY_EXPLANATION_ONLY。",
      },
    ],
    delegateTo: "claude",
  });
  const question = await until(
    () =>
      worker
        .state()
        .params.questions.find(
          ({ method }) => method === "item/tool/requestUserInput",
        ),
    "Claude 原生问题回到 agy",
  );
  assert.equal(question.params.executorName, "Claude Code");
  const activity = createActivitySource(
    () => mapState(worker.state().params, "agy"),
    delegationActivity,
  );
  const mainWait = async () =>
    (await activity.snapshot()).facts.get(resourceId("agy", thread.id));
  assert.equal((await mainWait()).has("waitingForInput"), true);
  assert.equal((await mainWait()).has("waitingForApproval"), false);
  assert.ok(
    executorPrompts.claude.some((prompt) =>
      prompt.includes("检查并报告具体证据"),
    ),
  );
  assert.ok(
    executorPrompts.claude.every(
      (prompt) => !prompt.includes("SECRETARY_EXPLANATION_ONLY"),
    ),
  );
  const previousPid = worker.state().params.pid;
  process.kill(previousPid, "SIGKILL");
  await until(() => !worker.ready, "原委派服务 IPC 已断开");
  worker.close();
  worker = connect();
  await worker.connect();
  assert.notEqual(worker.state().params.pid, previousPid);
  const reopenedCodex = await Promise.all([
    rpc("thread/read", { threadId: "delegation/" + task.id }),
    rpc("thread/turns/list", { threadId: "delegation/" + task.id, limit: 1 }),
    rpc("thread/items/list", {
      threadId: "delegation/" + task.id,
      sortDirection: "asc",
      limit: 200,
    }),
  ]);
  assert.equal(reopenedCodex[0].thread.id, "delegation/" + task.id);
  assert.equal(reopenedCodex[1].data[0].status, "completed");
  assert(
    reopenedCodex[2].data.some(({ item }) => item.text === "FIXTURE_WRITE"),
  );
  await until(
    () => worker.state().params.questions.some(({ id }) => id === question.id),
    "委派服务重启后保留原生问题",
  );
  await rpc("lan/agy/respond", {
    threadId: thread.id,
    requestId: question.id,
    result: { answers: { 0: { answers: ["确认"] } } },
  });
  await until(
    async () => !(await mainWait())?.has("waitingForInput"),
    "主会话退出输入等待",
  );
  console.log("PASS Claude 原生提问在秘书主会话归入等待输入，答复后清除");
  const claudeTask = await until(
    async () =>
      Object.values((await saved()).tasks).find(
        ({ target, status }) => target === "claude" && status === "completed",
      ),
    "Claude 原生执行",
  );
  const claudeHistory = await rpc("thread/items/list", {
    threadId: "delegation/" + claudeTask.id,
    limit: 200,
  });
  assert(
    claudeHistory.data.some(({ item }) => item.text === "CLAUDE_NATIVE_RESULT"),
  );
  assert.equal(claudeTask.steps.at(-1).result.answer, "CLAUDE_NATIVE_RESULT");
  await until(
    async () =>
      Object.values((await saved()).notices).filter(
        ({ status }) => status === "delivered",
      ).length >= 3,
    "原会话结果投递",
  );
  assert(asked);
  assert(
    provider.requests.some(({ messages }) =>
      JSON.stringify(messages).includes("确认"),
    ),
  );
  for (const target of ["codex", "claude"]) {
    const { thread: parent } = await rpc("thread/start", { cwd });
    await rpc("turn/start", {
      threadId: parent.id,
      input: [{ type: "text", text: "AGY_BACKGROUND_TEST" }],
      delegateTo: target,
    });
    const backgroundTask = async () =>
      Object.values((await saved()).tasks).find(
        ({ parentId }) => parentId === parent.id,
      );
    const notices = async () =>
      Object.values((await saved()).notices).filter(
        ({ parentId }) => parentId === parent.id,
      );
    const replyInHistory = async (suffix) => {
      const task = await backgroundTask();
      if (!task?.steps[0].turnId) return false;
      const { thread } = await rpc("thread/read", {
        threadId: "delegation/" + task.id,
        includeTurns: true,
      });
      return thread.turns.some(
        ({ items, status }) =>
          status === "completed" &&
          items.some(
            ({ text }) => text === target.toUpperCase() + "_STAGE_" + suffix,
          ),
      );
    };
    const result = async () =>
      (await notices()).find(({ kind }) => kind === "result");
    const processed = new Set();
    await until(async () => {
      for (const approval of worker.state().params.questions) {
        if (
          approval.method !== "lan/agy/permission" ||
          approval.params.threadId !== parent.id ||
          processed.has(approval.id)
        )
          continue;
        processed.add(approval.id);
        await rpc("lan/agy/respond", {
          threadId: parent.id,
          requestId: approval.id,
          result: { optionId: "allow" },
        });
      }
      return replyInHistory(3);
    }, target + " 初始轮次结束");
    await delay(2800);
    assert.equal((await backgroundTask()).status, "running");
    assert.deepEqual(await notices(), []);
    await writeFile(join(cwd, target + "-release-1"), "");
    await until(() => replyInHistory(4), target + " 第一项终端触发的轮次完成");
    await delay(2800);
    assert.equal((await backgroundTask()).status, "running");
    assert.deepEqual(await notices(), []);
    worker.close();
    worker = connect();
    await worker.connect();
    await writeFile(join(cwd, target + "-release-2"), "");
    await until(() => lastWake[target].entered, target + " 第二次续跑进入模型");
    assert.deepEqual(await notices(), []);
    lastWake[target].release.resolve();
    const final = await until(async () => {
      const notice = await result();
      return notice?.status === "delivered" && notice.payload;
    }, target + " 所有终端结束后的最终回投");
    assert.equal(final.status, "completed");
    const prefix =
      target === "codex" ? "agy-background-" : "toolu_agy_background_";
    assert.deepEqual(
      final.callChain.map(({ callId }) => callId),
      [traceId(prefix + "1"), traceId(prefix + "2")],
    );
    const session = (await saved()).sessions[parent.id];
    const transcript = JSON.parse(
      await readFile(join(cwd, session.nativeId + ".json"), "utf8"),
    );
    const detail = transcript.find(({ evidence }) => evidence)?.evidence;
    assert.equal(detail.stepId, final.stepId);
    assert.equal(detail.call.callId, traceId(prefix + "1"));
    if (target === "codex") {
      assert.match(detail.raw.input.payload.arguments, /codex-release-1/);
      const output = detail.raw.outputs[0].payload.output;
      const job = JSON.parse(
        output.find(({ text }) => text.startsWith("{")).text,
      ).job;
      assert.equal(job.callId, prefix + "1");
      assert.equal(job.title, "Codex terminal 1");
    } else {
      assert.match(detail.raw[0].block.input.command, /claude-release-1/);
      assert.match(JSON.stringify(detail.raw[1].block.content), /background/i);
    }
    console.log(
      target + " 结果带双调用 ID，秘书 MCP 逐项读取原生工具输入和输出。",
    );
    const historyResult = (await backgroundTask()).steps[0].result;
    assert.equal(
      historyResult.turns.length,
      3,
      JSON.stringify({
        final,
        history: (
          await rpc("thread/read", {
            threadId: "delegation/" + (await backgroundTask()).id,
            includeTurns: true,
          })
        ).thread.turns.map(
          ({ id, status, automatic, backgroundTriggers, items }) => ({
            id,
            status,
            automatic,
            backgroundTriggers,
            items: items.map(({ type, text }) => ({ type, text })),
          }),
        ),
      }),
    );
    assert.match(
      final.answer,
      /STAGE_3[\s\S]*terminal 1[\s\S]*STAGE_4[\s\S]*terminal 2[\s\S]*STAGE_5/,
    );
    assert.equal(historyResult.turns[0].triggers.length, 0);
    assert.notEqual(
      historyResult.turns[1].triggers[0].id,
      historyResult.turns[2].triggers[0].id,
    );
    assert.equal((await backgroundTask()).status, "completed");
    assert.equal((await notices()).length, 1);
    console.log(
      target +
        " 两个终端分批退出，期间零回投，第二次续跑结束后仅回投一次并标注三轮来源。",
    );
  }
  for (const [target, mode] of [
    ["codex", "RUNNING"],
    ["claude", "RUNNING"],
    ["claude", "APPROVAL"],
  ]) {
    const { thread: parent } = await rpc("thread/start", { cwd });
    const send = (method, text, expectedTurnId) =>
      rpc(method, {
        threadId: parent.id,
        delegateTo: target,
        input: [{ type: "text", text }],
        ...(expectedTurnId && { expectedTurnId }),
      });
    const { turn: secretary } = await send(
      "turn/start",
      "AGY_TAKEOVER_" + mode + (target === "codex" ? " AGY_STEER" : ""),
    );
    const readTask = async () =>
      Object.values((await saved()).tasks).find(
        ({ parentId }) => parentId === parent.id,
      );
    const previous = await until(async () => {
      const task = await readTask();
      return (
        (mode === "APPROVAL" ? task?.request : task?.steps[0].turnId) && task
      );
    }, target + " 旧委派已进入原生执行");
    if (mode === "RUNNING")
      await until(() => takeovers[target].entered, "旧执行进入模型");
    const approval = previous.request?.localId;
    await send(
      target === "codex" ? "turn/steer" : "turn/start",
      "AGY_REPLACE。你负责后续汇报，SECRETARY_FOLLOWUP_ONLY。",
      secretary.id,
    );
    const delivered = await until(async () => {
      const state = await saved();
      return Object.values(state.notices).find(
        ({ parentId, kind, status }) =>
          parentId === parent.id && kind === "result" && status === "delivered",
      );
    }, target + " 新需求执行并回投");
    const current = await readTask();
    assert.equal(current.id, previous.id);
    assert.equal(current.executor.threadId, previous.executor.threadId);
    assert.equal(current.steps.length, 2);
    assert.equal(current.steps[0].result, undefined);
    assert.equal(delivered.stepId, current.steps[1].id);
    assert.equal(
      delivered.payload.answer,
      target.toUpperCase() + "_REPLACEMENT_RESULT",
    );
    assert.equal(
      Object.values((await saved()).notices).filter(
        ({ parentId }) => parentId === parent.id,
      ).length,
      1,
    );
    if (mode === "RUNNING") takeovers[target].release.resolve();
    const history = await rpc("thread/read", {
      threadId: "delegation/" + current.id,
      includeTurns: true,
    });
    assert.equal(
      history.thread.turns.find(({ id }) => id === previous.steps[0].turnId)
        ?.status,
      "interrupted",
    );
    if (approval) {
      assert(
        events.some(
          ({ method, params }) =>
            method === "serverRequest/resolved" &&
            params.requestId === approval,
        ),
      );
      await assert.rejects(
        rpc("lan/agy/respond", {
          threadId: parent.id,
          requestId: approval,
          result: { answers: {} },
        }),
        /委派审批已结束/,
      );
    }
    if (target === "codex") {
      const { thread } = await rpc("thread/read", {
        threadId: parent.id,
        includeTurns: true,
      });
      assert.equal(
        thread.turns.find(({ id }) => id === secretary.id).status,
        "interrupted",
      );
    }
    console.log(
      target + " " + mode + "：旧轮次已打断，同一原生会话仅返回新步骤的结果。",
    );
  }
  for (const prompts of Object.values(executorPrompts))
    assert.ok(
      prompts.every((prompt) => !prompt.includes("SECRETARY_FOLLOWUP_ONLY")),
    );
  console.log(
    "秘书直接答复时无委派，Codex 与 Claude Code 的首次派单和续问均只收到技术任务。",
  );
  await worker.shutdown();
  console.log(
    "agy 工作进程、两路原生执行、去重、同会话补问、桥接重连、任务服务重启、审批、落盘、撤销和历史通过。",
  );
} catch (error) {
  const value = await saved().catch(() => ({}));
  const tasks = Object.values(value.tasks || {}).map(
    ({ status, executor, steps }) => ({
      status,
      executor: Boolean(executor),
      turns: steps.map(({ turnId, result }) => ({
        accepted: Boolean(turnId),
        result,
      })),
    }),
  );
  console.error({
    tasks,
    modelRequests,
    codexCalls,
    claudeBackgroundCalls,
    notices: Object.values(value.notices || {})
      .slice(-8)
      .map(({ kind, status, payload }) => ({ kind, status, payload })),
    claudeNative: (
      await readFile(
        join(root, "backends", "claude", "claudex-web-index.json"),
        "utf8",
      ).catch(() => "")
    ).slice(-8000),
    eventMethods: events.slice(-40).map(({ method, params }) => ({
      method,
      status: params?.turn?.status || params?.item?.agentStatus,
    })),
    nativeErrors,
    worker: (
      await readFile(join(backend.stateDir, "worker.log"), "utf8").catch(
        () => "",
      )
    ).slice(-7000),
  });
  throw error;
} finally {
  gate.resolve();
  for (const slots of [takeovers, lastWake])
    for (const slot of Object.values(slots)) slot.release.resolve();
  const workerPid = worker.state().params.pid;
  worker.close();
  if (workerPid)
    try {
      process.kill(workerPid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  native.kill();
  for (const target of ["codex", "claude"])
    for (const number of [1, 2])
      await writeFile(join(cwd, target + "-release-" + number), "");
  backgroundWorker.kill();
  codex.closeAllConnections();
  codex.close();
  await provider.close();
  await shutdownBrowserClaudeWorker(config).catch(() => {});
  const { socket } = workerLocation(backend.stateDir);
  await rm(socket, { force: true });
  for (const [key, value] of Object.entries({
    PATH: oldPath,
    XDG_RUNTIME_DIR: oldRuntime,
    ANTHROPIC_BASE_URL: oldEndpoint,
    ANTHROPIC_API_KEY: oldKey,
    ANTHROPIC_AUTH_TOKEN: oldAuth,
  }))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  await rm(root, { recursive: true, force: true });
}

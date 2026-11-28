import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCodexAdapter } from "../../server/src/backends/codex/adapter.mjs";
import { codexConversationMcpName } from "../../server/src/backends/codex/conversation-tools.mjs";
import { createUpstream } from "../../server/src/backends/codex/upstream.mjs";
import { createConversationManager } from "../../server/src/conversation-manager/manager.mjs";
import { conversationCollaborationInstructions } from "../../server/src/conversation-manager/instructions.mjs";
import { formatLegacyConversationMessage } from "../../server/src/conversation-manager/message.mjs";

const root = await mkdtemp(join(tmpdir(), "claudex-thread-chat-codex-"));
const home = join(root, "codex");
const cwd = join(root, "workspace");
const configDir = join(root, "bridge");
await Promise.all([home, cwd, configDir].map((path) => mkdir(path)));
const modelCalls = [];
const modelListCallId = "fixture-model-list-call";
const activeReplyBody = "A 忙碌时送到的明确回复";
const coordinationPrompt = "先了解工作区里还有谁在工作，再协调测试服务重启。";
const policyFixture =
  "Keep this fixture's work and output inside the test workspace.";
const encodedGuidance = JSON.stringify(
  conversationCollaborationInstructions(codexConversationMcpName),
).slice(1, -1);
function guidanceCopies(request) {
  return JSON.stringify(request).split(encodedGuidance).length - 1;
}
const modelGates = new Map([
  ["fixture-active-a", Promise.withResolvers()],
  ["fixture-active-b", Promise.withResolvers()],
  ["fixture-later-b", Promise.withResolvers()],
  ["fixture-active-reply-a", Promise.withResolvers()],
  ["fixture-active-reply-output", Promise.withResolvers()],
  ["fixture-race-a", Promise.withResolvers()],
]);
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (request.url !== "/v1/responses") return response.writeHead(404).end();
  const body = JSON.parse(raw);
  const index = modelCalls.push(body);
  const latest = body.input.at(-1);
  const gate = modelGates.get(latest?.content?.[0]?.text);
  if (gate) await gate.promise;
  if (
    body.input.some(
      (item) =>
        item.type === "function_call_output" &&
        typeof item.output === "string" &&
        item.output.includes(activeReplyBody),
    )
  )
    await modelGates.get("fixture-active-reply-output").promise;
  const id = "fixture-response-" + index;
  let item = {
    id: "fixture-message-" + index,
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "fixture answer" }],
  };
  if (
    latest?.role === "user" &&
    latest.content[0]?.text === coordinationPrompt
  ) {
    const tool = body.tools
      .flatMap(
        (entry) =>
          entry.tools?.map((child) => ({
            ...child,
            namespace: entry.name,
          })) ?? [entry],
      )
      .find((entry) => entry.name === "list_active_threads");
    assert(tool, "原生模型应取得会话发现工具");
    item = {
      type: "function_call",
      name: tool.name,
      namespace: tool.namespace,
      call_id: modelListCallId,
      arguments: JSON.stringify({ scope: "workspace" }),
    };
  }
  const events = [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
  );
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const reserved = createServer();
reserved.listen(0, "127.0.0.1");
await once(reserved, "listening");
const url = "ws://127.0.0.1:" + reserved.address().port;
await new Promise((resolve) => reserved.close(resolve));
await writeFile(
  join(home, "config.toml"),
  `model = "gpt-5.4"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
thread_unload_delay_secs = 0
project_doc_max_bytes = 0
web_search = "disabled"
[features]
apps = false
plugins = false
hooks = false
memories = false
code_mode = false
code_mode_host = false
code_mode_only = false
enable_request_compression = false
[model_providers.fixture]
name = "Local fixture"
base_url = "http://127.0.0.1:${model.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
`,
);
const executable = process.env.CODEX_EXECUTABLE || "codex";
const cliVersion = execFileSync(executable, ["--version"], {
  encoding: "utf8",
}).trim();
const binary = spawn(executable, ["app-server", "--listen", url], {
  cwd,
  env: {
    PATH: process.env.PATH,
    HOME: root,
    CODEX_HOME: home,
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
  },
  stdio: ["ignore", "ignore", "pipe"],
});
const exited = once(binary, "exit");
let diagnostics = "";
binary.stderr.on("data", (chunk) => {
  diagnostics = (diagnostics + chunk).slice(-12000);
});
const serviceOptions = { configDir, retryMs: 80 };
let manager;
let adapter;
let binding;
const events = [];
const direct = createUpstream({
  config: { upstreamUrl: url },
  version: { displayVersion: "fixture" },
  send() {},
  onEvent(message) {
    events.push(message);
  },
  onReady() {},
  onResponse() {},
  onSettled() {},
  onDisconnect() {},
});
const requests = new Map();
const client = { readyState: 1 };
let sequence = 0;
function webCall(method, params = {}) {
  const id = ++sequence;
  const deferred = Promise.withResolvers();
  requests.set(id, { ...deferred, method });
  const timeout = setTimeout(
    () => deferred.reject(new Error("请求超时 " + method)),
    15000,
  );
  return Promise.resolve(adapter.receive(client, { id, method, params }))
    .then(() => deferred.promise)
    .finally(() => {
      clearTimeout(timeout);
      requests.delete(id);
    });
}
async function until(read, label) {
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(40);
  }
  throw new Error(label + "\n" + diagnostics);
}
const input = (text) => [{ type: "text", text }];
const complete = (turn) =>
  until(
    () =>
      events.find(
        (event) =>
          event.method === "turn/completed" && event.params.turn.id === turn,
      )?.params.turn,
    "等待原生轮次结束",
  );
const modelSaw = (search, test) =>
  until(
    () =>
      modelCalls.find((call) => call.input.some((item) => test(item, search))),
    "等待隔离模型收到 " + search,
  );
const userInput = (item, text) =>
  item.role === "user" && item.content?.some((part) => part.text === text);
const peerInput = (item, id) =>
  item.type === "function_call_output" &&
  item.name === "thread_chat_message" &&
  item.output?.startsWith("Claudex thread_chat message " + id + "\n");
async function tool(threadId, name, args) {
  const result = await direct.call("mcpServer/tool/call", {
    threadId,
    server: codexConversationMcpName,
    tool: name,
    arguments: args,
    meta: { threadId: "ignored-fixture-thread" },
  });
  assert.equal(Boolean(result.isError), false, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}
async function connectBridge() {
  manager = createConversationManager(serviceOptions);
  await manager.start();
  binding = manager.bindBackend(
    { id: "codex", type: "codex", url, dataDir: home },
    () => adapter?.conversationManager,
  );
  adapter = createCodexAdapter({
    ...binding,
    backend: { dataDir: home, url },
    config: { configDir, codexHome: home, upstreamUrl: url },
    version: { displayVersion: "fixture" },
    send(_client, { id, result, error }) {
      const request = requests.get(id);
      if (error)
        request?.reject(new Error(`${request.method}: ${error.message}`));
      else request?.resolve(result);
    },
    broadcast(message) {
      events.push(message);
      manager?.wake();
    },
  });
  adapter.connect();
  await until(() => adapter.ready, "网页适配器连接到真实 app-server");
}
async function disconnectBridge() {
  const currentAdapter = adapter;
  adapter = undefined;
  currentAdapter?.close();
  await manager?.close();
  manager = undefined;
}
try {
  direct.connect();
  await until(() => direct.ready, "连接真实 app-server");
  console.log(cliVersion);
  const first = await direct.call("thread/start", {
    cwd,
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  const a = first.thread.id;
  await direct.call("thread/name/set", { threadId: a, name: "历史会话 A" });
  const legacyTools = await direct.call("mcpServerStatus/list", {
    threadId: a,
  });
  assert(
    !legacyTools.data.some(
      (server) => server.name === codexConversationMcpName,
    ),
  );
  const seed = await direct.call("turn/start", {
    threadId: a,
    input: input("fixture-seed"),
  });
  assert.equal((await complete(seed.turn.id)).status, "completed");
  assert.equal(guidanceCopies(modelCalls[0]), 0);
  await direct.call("thread/unsubscribe", { threadId: a });
  await until(
    async () => !(await direct.call("thread/loaded/list", {})).data.includes(a),
    "旧会话卸载",
  );
  await connectBridge();
  const resumed = await webCall("thread/resume", {
    threadId: a,
    excludeTurns: true,
  });
  assert.equal(resumed.thread.id, a);
  assert.equal(resumed.approvalPolicy, "never");
  assert.equal(resumed.sandbox.type, "readOnly");
  const activeA = await webCall("turn/start", {
    threadId: a,
    input: input("fixture-active-a"),
    additionalContext: {
      fixture_policy: { kind: "application", value: policyFixture },
    },
  });
  const resumedModel = await modelSaw("fixture-active-a", userInput);
  const registeredNamespace = resumedModel.tools.find(
    (item) => item.name === `mcp__${codexConversationMcpName}`,
  );
  assert(
    registeredNamespace?.tools.some(
      (item) => item.name === "list_active_threads",
    ),
  );
  assert.equal(guidanceCopies(resumedModel), 1);
  assert(
    resumedModel.input.some(
      (item) =>
        item.role === "developer" &&
        item.content.some((part) => part.text?.includes(policyFixture)),
    ),
  );
  const configured = await direct.call("config/read", { cwd });
  assert(
    !JSON.stringify(configured).includes(
      binding.conversationToolEndpoint.token,
    ),
  );
  console.log(
    "PASS 旧会话冷恢复后取得真实 MCP 工具，保留其原有审批与沙箱配置。",
  );

  const second = await webCall("thread/start", {
    cwd,
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  const b = second.thread.id;
  await webCall("thread/name/set", { threadId: b, name: "会话 B" });
  const activeB = await webCall("turn/start", {
    threadId: b,
    input: input("fixture-active-b"),
  });
  const freshModel = await modelSaw("fixture-active-b", userInput);
  assert.equal(guidanceCopies(freshModel), 1);
  const workspace = await tool(a, "list_active_threads", {
    scope: "workspace",
  });
  const global = await tool(a, "list_active_threads", {
    scope: "global",
    title: "会话 B",
  });
  const recipient = workspace.threads.find((item) => item.title === "会话 B");
  assert(recipient);
  assert.equal(global.threads[0].threadId, recipient.threadId);
  assert.equal(recipient.status, "running");
  console.log("PASS 同工作区与本后端全局查询找到忙碌会话 B。");

  const question = {
    action: "send",
    threadId: recipient.threadId,
    body: "测试问题",
    requestId: "fixture-question",
  };
  const accepted = await tool(a, "thread_chat", question);
  const duplicate = await tool(a, "thread_chat", question);
  assert.equal(accepted.messageId, duplicate.messageId);
  assert.equal(accepted.status, "accepted");
  assert(
    !modelCalls.some((call) =>
      call.input.some((item) => peerInput(item, accepted.messageId)),
    ),
  );
  modelGates.get("fixture-active-a").resolve();
  assert.equal((await complete(activeA.turn.id)).status, "completed");
  console.log(
    "PASS 问题立即返回稳定消息 ID。A 可以完成当前轮次，忙碌的 B 继续原轮次。",
  );

  const modelList = await webCall("turn/start", {
    threadId: a,
    input: input(coordinationPrompt),
  });
  assert.equal(
    guidanceCopies(await modelSaw(coordinationPrompt, userInput)),
    1,
  );
  const listOutput = (item, callId) =>
    item.type === "function_call_output" && item.call_id === callId;
  const modelContinuation = await modelSaw(modelListCallId, listOutput);
  assert.equal(guidanceCopies(modelContinuation), 1);
  const result = modelContinuation.input.find((item) =>
    listOutput(item, modelListCallId),
  );
  assert(JSON.stringify(result.output).includes(recipient.threadId));
  assert(!JSON.stringify(result.output).includes("历史会话 A"));
  assert.equal((await complete(modelList.turn.id)).status, "completed");
  console.log(
    "PASS 原生模型发出会话工具调用，后续请求收到同工作区的 B，调用方 A 被排除。",
  );

  await disconnectBridge();
  await connectBridge();
  await webCall("thread/resume", { threadId: b, excludeTurns: true });
  await direct.call("config/mcpServer/reload", undefined, {
    trackThread: false,
  });
  modelGates.get("fixture-active-b").resolve();
  assert.equal((await complete(activeB.turn.id)).status, "completed");
  const inbound = await modelSaw(accepted.messageId, peerInput);
  assert.equal(guidanceCopies(inbound), 1);
  const requestNotice = inbound.input.find((item) =>
    peerInput(item, accepted.messageId),
  );
  assert(requestNotice.output.includes("Peer request. If it asks a question"));
  assert(requestNotice.output.includes(codexConversationMcpName));
  assert(
    !inbound.input.some(
      (item) =>
        item.role === "user" &&
        JSON.stringify(item).includes(accepted.messageId),
    ),
  );
  const status = await until(async () => {
    const value = await binding.callConversationTool(
      { threadId: a },
      "thread_chat",
      { action: "status", messageId: accepted.messageId },
    );
    return value.status === "delivered" ? value : null;
  }, "读取原生输入证据");
  assert.equal(status.replies.length, 0);
  console.log("PASS 桥接重建后，原问题以工具结果送达 B，状态引用原生历史。");

  const later = await webCall("turn/start", {
    threadId: b,
    input: input("fixture-later-b"),
  });
  await modelSaw("fixture-later-b", userInput);
  const reply = await tool(b, "thread_chat", {
    action: "reply",
    replyTo: accepted.messageId,
    body: "下一轮给出的测试回复",
    requestId: "fixture-reply",
  });
  await modelSaw(reply.messageId, peerInput);
  const settled = await until(async () => {
    const value = await binding.callConversationTool(
      { threadId: a },
      "thread_chat",
      { action: "status", messageId: accepted.messageId },
    );
    return value.replies[0]?.status === "delivered" ? value : null;
  }, "读取延迟回复");
  assert.equal(settled.replies[0].replyTo, accepted.messageId);
  assert.equal(
    (await complete(settled.replies[0].receipt.evidence.turnId)).status,
    "completed",
  );
  console.log(
    "PASS B 在后续轮次回复，空闲 A 在原会话收到带原问题引用的工具结果。",
  );

  const waitingA = await webCall("turn/start", {
    threadId: a,
    input: input("fixture-active-reply-a"),
  });
  await modelSaw("fixture-active-reply-a", userInput);
  const activeAAddress = await tool(b, "list_active_threads", {
    scope: "workspace",
    title: "历史会话 A",
  });
  const queuedOrdinary = await tool(b, "thread_chat", {
    action: "send",
    threadId: activeAAddress.threads[0].threadId,
    body: "先排队的普通消息",
    requestId: "fixture-ordinary-before-reply",
  });
  assert.equal(queuedOrdinary.status, "accepted");
  const replyWhileActive = await tool(b, "thread_chat", {
    action: "reply",
    replyTo: accepted.messageId,
    body: activeReplyBody,
    requestId: "fixture-active-reply",
  });
  const messageStatusFromB = (messageId) =>
    binding.callConversationTool({ threadId: b }, "thread_chat", {
      action: "status",
      messageId,
    });
  const awaitStatusFromB = (messageId, state) =>
    until(async () => {
      const status = await messageStatusFromB(messageId);
      return status.status === state ? status : null;
    }, `等待消息达到 ${state} 状态`);
  const admitted = await awaitStatusFromB(replyWhileActive.messageId, "queued");
  assert.equal(admitted.receipt.evidence.turnId, waitingA.turn.id);
  assert.equal(
    (await messageStatusFromB(queuedOrdinary.messageId)).status,
    "accepted",
  );
  modelGates.get("fixture-active-reply-a").resolve();
  const activeReplyInput = await modelSaw(
    replyWhileActive.messageId,
    peerInput,
  );
  const replyNotice = activeReplyInput.input.find((item) =>
    peerInput(item, replyWhileActive.messageId),
  );
  assert(
    replyNotice.output.includes(
      "Peer reply. Use it to continue the work it unblocks.",
    ),
  );
  assert(
    activeReplyInput.input.some((item) =>
      userInput(item, "fixture-active-reply-a"),
    ),
  );
  assert(
    !events.some(
      (event) =>
        event.method === "turn/completed" &&
        event.params.turn.id === waitingA.turn.id,
    ),
  );
  modelGates.get("fixture-active-reply-output").resolve();
  assert.equal((await complete(waitingA.turn.id)).status, "completed");
  const activeDelivery = await awaitStatusFromB(
    replyWhileActive.messageId,
    "delivered",
  );
  assert.equal(activeDelivery.receipt.evidence.turnId, waitingA.turn.id);
  assert.equal(activeDelivery.replyTo, accepted.messageId);
  const ordinaryDelivery = await awaitStatusFromB(
    queuedOrdinary.messageId,
    "delivered",
  );
  assert.notEqual(ordinaryDelivery.receipt.evidence.turnId, waitingA.turn.id);
  assert.equal(
    (await complete(ordinaryDelivery.receipt.evidence.turnId)).status,
    "completed",
  );
  console.log(
    "PASS B 的明确回复在 A 原轮次仍运行时进入下一次模型请求，A 无需查询。更早排队的普通消息在 A 空闲后送达。",
  );
  modelGates.get("fixture-later-b").resolve();
  assert.equal((await complete(later.turn.id)).status, "completed");

  await webCall("thread/archive", { threadId: b });
  const archivedQuestion = await binding.callConversationTool(
    { threadId: a },
    "thread_chat",
    { ...question, requestId: "fixture-archived-question" },
  );
  await until(async () => {
    const value = await binding.callConversationTool(
      { threadId: a },
      "thread_chat",
      { action: "status", messageId: archivedQuestion.messageId },
    );
    return value.status === "failed" ? value : null;
  }, "归档会话拒绝投递");
  assert(!(await direct.call("thread/loaded/list", {})).data.includes(b));
  console.log("PASS 已归档的目标保持关闭，发送方取得明确失败状态。");

  const racing = await webCall("turn/start", {
    threadId: a,
    input: input("fixture-race-a"),
  });
  await modelSaw("fixture-race-a", userInput);
  const raceId = "fixture-race-message";
  const legacyReply = {
    id: raceId,
    replyTo: accepted.messageId,
    from: {
      threadId: b,
      runtimeId: binding.conversationToolEndpoint.runtimeId,
      title: "会话 B",
    },
    to: { threadId: a },
    body: "Fixture peer data.",
  };
  const legacyText = formatLegacyConversationMessage(legacyReply);
  // Reproduce a native turn that won the race after the bridge observed idle.
  const raceAdmission = await direct.call("turn/start", {
    threadId: a,
    input: [],
    turnTrigger: "thread_chat",
    toolOutput: {
      name: "thread_chat_message",
      namespace: codexConversationMcpName,
      output: legacyText,
      retain: true,
    },
  });
  assert.equal(raceAdmission.turn.id, racing.turn.id);
  modelGates.get("fixture-race-a").resolve();
  const racingModelInput = await modelSaw(raceId, peerInput);
  assert(
    !racingModelInput.input.some(
      (item) => item.role === "user" && JSON.stringify(item).includes(raceId),
    ),
  );
  assert.equal((await complete(racing.turn.id)).status, "completed");
  const nativeHistory = await direct.call("thread/turns/list", {
    threadId: a,
    itemsView: "full",
  });
  const actualTurn = nativeHistory.data.find(
    (turn) => turn.id === racing.turn.id,
  );
  const legacyItem = actualTurn.items.find(
    (item) => item.type === "functionCallOutput" && item.output === legacyText,
  );
  assert(legacyItem);
  assert.equal(legacyItem.name, "thread_chat_message");
  assert.equal(legacyItem.namespace, codexConversationMcpName);
  assert.deepEqual(await adapter.conversationManager.reconcile(legacyReply), {
    status: "delivered",
    evidence: { turnId: racing.turn.id, itemId: legacyItem.id },
  });
  console.log(
    "PASS 已启动的原生轮次在竞争发生时接收工具结果，可从原生历史精确恢复旧格式回复。",
  );

  const { thread: fork } = await webCall("thread/fork", {
    threadId: a,
    excludeTurns: true,
  });
  assert.equal(fork.forkedFromId, a);
  const privatePrompt = "只在当前会话给出这句测试文本的措辞修订。";
  const beforePrivate = modelCalls.length;
  const privateTurn = await webCall("turn/start", {
    threadId: fork.id,
    input: input(privatePrompt),
  });
  const privateModel = await modelSaw(privatePrompt, userInput);
  assert.equal(guidanceCopies(privateModel), 1);
  assert.equal((await complete(privateTurn.turn.id)).status, "completed");
  assert.equal(modelCalls.slice(beforePrivate).length, 1);
  console.log(
    "PASS 协作指引随真实 MCP 注册进入首次、冷恢复、重载和分支模型请求，每次仅一份，原开发者上下文保留。私有任务对照由夹具直接作答。",
  );
  console.log(
    `通过，本地 Responses 夹具请求 ${modelCalls.length} 次，外部模型调用 0 次。`,
  );
} finally {
  for (const gate of modelGates.values()) gate.resolve();
  await disconnectBridge();
  direct.close();
  if (binary.exitCode === null) binary.kill("SIGTERM");
  await exited;
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}

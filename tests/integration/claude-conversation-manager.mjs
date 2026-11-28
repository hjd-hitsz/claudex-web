import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createClaudeWorkerAdapter } from "../../server/src/backends/claude/worker-client.mjs";
import { workerLocation } from "../../server/src/backends/claude/worker-location.mjs";
import { createConversationManager } from "../../server/src/conversation-manager/manager.mjs";
import { conversationCollaborationInstructions } from "../../server/src/conversation-manager/instructions.mjs";
import { messagesServer } from "../helpers/claude-messages-server.mjs";

const root = await mkdtemp(join(tmpdir(), "claude-conversation-"));
const cwd = join(root, "project");
const cli = process.env.CLAUDE_EXECUTABLE || "claude";
const backend = {
  id: "claude",
  type: "claude",
  enabled: true,
  executable: cli,
  dataDir: join(root, "native"),
  stateDir: join(root, "state"),
  args: [],
};
const config = {
  configDir: root,
  claudeHome: backend.dataDir,
  codexHome: root,
  backendsFile: join(root, "backends.json"),
  defaultCwd: cwd,
  projectlessRoot: join(root, "workspaces"),
};
const mcpServerName = "claudex_conversation";
const toolNames = {
  list: `mcp__${mcpServerName}__list_active_threads`,
  chat: `mcp__${mcpServerName}__thread_chat`,
};
const hold = Promise.withResolvers();
const events = [];
const native = { asks: 0, replies: 0, calls: [] };
const turnText = (text) => [{ type: "text", text }];
const toolUse = (name, input, id) => [{ type: "tool_use", id, name, input }];
const coordination =
  "Find who is working in this workspace and ask them about their progress while continuing independently.";
const localCheck =
  "What is written in the project-label.txt file in this workspace?";
const activeWork =
  "Fixture A continues independent work with its existing tool.";
const activeReplyBody = "Fixture reply delivered while A continues working";
const releaseActiveWork = join(cwd, ".active-work-release");
const projectLabel = "Claudex isolated native project marker";
const collaborationInstructions =
  conversationCollaborationInstructions(mcpServerName);
const mcpInstruction = JSON.stringify(collaborationInstructions).slice(1, -1);

function verifyInstructions(body) {
  const context = JSON.stringify(body);
  assert.equal(
    context.split(mcpInstruction).length - 1,
    1,
    "Claude receives one collaboration policy",
  );
  assert.ok(
    collaborationInstructions.includes(`Use the ${mcpServerName} MCP server`),
  );
  assert.match(
    collaborationInstructions,
    /Start with list_active_threads in your workspace/,
  );
  assert.match(
    collaborationInstructions,
    /Claudex immediately pushes it back to this conversation/,
  );
  const paragraphs = collaborationInstructions.split("\n");
  const send = paragraphs.findIndex((part) =>
    part.includes('Set action to "send"'),
  );
  const retry = paragraphs.findIndex((part) =>
    part.includes("same arguments and requestId"),
  );
  const reply = paragraphs.findIndex((part) => part.includes('action "reply"'));
  const troubleshooting = paragraphs.findIndex((part) =>
    part.includes('action "status"'),
  );
  assert.ok(
    send >= 0 && send <= retry && retry < reply && reply < troubleshooting,
    "Claude receives send and retry guidance before replying and troubleshooting",
  );
  assert.match(paragraphs[reply], /reply immediately if you have enough facts/);
  assert.match(paragraphs[reply], /messageId as replyTo/);
  assert.match(
    paragraphs[reply],
    /gather them with the necessary tools, then reply/,
  );
  assert.match(
    paragraphs[reply],
    /Send the reply directly without waiting for a separate user instruction, authorization, or approval/,
  );
  assert.doesNotMatch(
    collaborationInstructions,
    /as many tool calls|scope for what you share|approvals required for the work needed to answer/,
  );
}

function verifyReplyPrompt(body, replyBody) {
  const prompt = [
    body.system,
    ...body.messages.map((message) => message.content),
  ]
    .flatMap((content) =>
      typeof content === "string"
        ? [content]
        : (content ?? []).map((block) => block.text),
    )
    .findLast(
      (text) =>
        text?.includes("Claudex thread_chat message ") &&
        text.includes(replyBody),
    );
  assert.ok(prompt, "Claude receives the peer reply in its native request");
  assert.match(
    prompt,
    /Peer reply\. Use it to continue the work it unblocks\./,
  );
  assert.doesNotMatch(prompt, /Peer request\. If it asks a question/);
  assert.ok(prompt.includes(`"replyTo":"${native.ack.messageId}"`));
  assert.doesNotMatch(prompt, /with action "reply"/);
}

function loadTools(body, names, id) {
  if (
    names.every((name) =>
      body.tools.some((tool) => tool.name === name && !tool.defer_loading),
    )
  )
    return null;
  assert.ok(body.tools.some((tool) => tool.name === "ToolSearch"));
  return toolUse("ToolSearch", { query: `select:${names.join(",")}` }, id);
}

function discover(body) {
  const discovery = body.tools.find((tool) => tool.name === toolNames.list);
  const chat = body.tools.find((tool) => tool.name === toolNames.chat);
  assert.deepEqual(discovery.input_schema.properties.scope.enum, [
    "workspace",
    "global",
  ]);
  assert.deepEqual(chat.input_schema.properties.action.enum, [
    "send",
    "reply",
    "status",
    "inbox",
    "stop_waiting",
  ]);
  assert.equal(chat.input_schema.properties.expectReply.type, "boolean");
  assert.equal(chat.input_schema.properties.body.maxLength, 65536);
  return toolUse(toolNames.list, { scope: "workspace" }, "toolu_discover_b");
}

function reply(messageId, active = false) {
  return toolUse(
    toolNames.chat,
    {
      action: "reply",
      replyTo: messageId,
      requestId: active ? "fixture-active-reply" : "fixture-reply",
      body: active ? activeReplyBody : "Fixture late reply body",
    },
    "toolu_reply_to_a",
  );
}

function launchChild() {
  return toolUse(
    "Agent",
    {
      description: "Fixture child caller",
      subagent_type: "general-purpose",
      prompt: "Fixture child attempts conversation tool",
      run_in_background: false,
    },
    "toolu_launch_native_child",
  );
}

let busy = false;
const service = await messagesServer(async (body) => {
  if (!body.tools?.some((tool) => tool.name === "Bash"))
    return turnText("Fixture metadata");
  const latest = body.messages.findLast((message) => message.role === "user");
  const content = Array.isArray(latest.content)
    ? latest.content
    : [{ type: "text", text: latest.content }];
  const input = content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const result = content.find((item) => item.type === "tool_result");
  if (!native.initialRequest) native.initialRequest = body;
  if (result?.tool_use_id === "toolu_prepare_coordination") {
    assert.equal(result.is_error, undefined);
    native.toolSearchLoadedCoordination = true;
    return discover(body);
  }
  if (result?.tool_use_id === "toolu_prepare_child")
    return toolUse(
      toolNames.list,
      { scope: "global" },
      "toolu_child_thread_tool",
    );
  if (result?.tool_use_id === "toolu_prepare_delegate") return launchChild();
  if (result?.tool_use_id === "toolu_prepare_reply") {
    const history = JSON.stringify(body.messages);
    return reply(/Fixture B replies to ([\da-f-]{36})/.exec(history)[1]);
  }
  if (result?.tool_use_id === "toolu_prepare_active_reply") {
    const history = JSON.stringify(body.messages);
    return reply(
      /Fixture B active reply to ([\da-f-]{36})/.exec(history)[1],
      true,
    );
  }
  if (result?.tool_use_id === "toolu_hold_active_work") {
    assert.match(
      JSON.stringify(result.content),
      /Fixture A native tool completed/,
    );
    verifyReplyPrompt(body, activeReplyBody);
    native.activeReplyVisible = true;
    return turnText("Fixture A continued its tool and received the peer reply");
  }
  if (result?.tool_use_id === "toolu_read_project_label") {
    assert.match(JSON.stringify(result.content), new RegExp(projectLabel));
    native.localRead = true;
    return turnText(projectLabel);
  }
  if (result?.tool_use_id === "toolu_child_thread_tool") {
    native.childDenial = result;
    return turnText("Fixture child tool checked");
  }
  if (result?.tool_use_id === "toolu_discover_b") {
    const value = JSON.parse(result.content[0].text);
    const target = value.threads.find((thread) => thread.title === "Fixture B");
    assert.ok(target, "SDK MCP discovery sees B while B is running");
    assert.equal(target.status, "running");
    return toolUse(
      toolNames.chat,
      {
        action: "send",
        threadId: target.threadId,
        requestId: "fixture-ask",
        body: "Fixture question body",
        expectReply: true,
      },
      "toolu_send_question",
    );
  }
  if (result?.tool_use_id === "toolu_send_question")
    native.ack = JSON.parse(result.content[0].text);
  if (result) return turnText("Fixture tool round finished");
  if (input.includes("Fixture keep B active")) {
    busy = true;
    await hold.promise;
  }
  if (input.includes(activeWork)) {
    return toolUse(
      "Bash",
      {
        command:
          "touch .active-work-ready; for ((attempt=0;attempt<300;attempt++)); do if test -f .active-work-release; then printf '%s\\n' 'Fixture A native tool completed'; exit 0; fi; sleep 0.05; done; exit 1",
        description: "Wait at a controlled fixture tool boundary",
        timeout: 18000,
      },
      "toolu_hold_active_work",
    );
  }
  if (input.includes(localCheck)) {
    verifyInstructions(body);
    return toolUse(
      "Read",
      { file_path: join(cwd, "project-label.txt") },
      "toolu_read_project_label",
    );
  }
  if (input.includes(coordination)) {
    verifyInstructions(body);
    assert.match(JSON.stringify(body), /Fixture native CLAUDE\.md marker/);
    assert.match(JSON.stringify(body), /Fixture local AGENTS\.md marker/);
    assert.match(JSON.stringify(body), /Fixture user CLAUDE\.md marker/);
    assert.match(
      JSON.stringify(body),
      /software engineering tasks|Claude Code/,
    );
    assert.ok(JSON.stringify(body).includes(cwd));
    const search = loadTools(
      body,
      [toolNames.list, toolNames.chat],
      "toolu_prepare_coordination",
    );
    assert.ok(
      search,
      "Claude receives native collaboration guidance before ToolSearch loads the tools",
    );
    return search;
  }
  if (input.includes("Fixture delegate identity check"))
    return (
      loadTools(body, ["Agent"], "toolu_prepare_delegate") || launchChild()
    );
  if (input.includes("Fixture child attempts conversation tool"))
    return (
      loadTools(body, [toolNames.list], "toolu_prepare_child") ||
      toolUse(toolNames.list, { scope: "global" }, "toolu_child_thread_tool")
    );
  const replying = /Fixture B replies to ([\da-f-]{36})/.exec(input);
  if (replying)
    return (
      loadTools(body, [toolNames.chat], "toolu_prepare_reply") ||
      reply(replying[1])
    );
  const replyingToActive = /Fixture B active reply to ([\da-f-]{36})/.exec(
    input,
  );
  if (replyingToActive)
    return (
      loadTools(body, [toolNames.chat], "toolu_prepare_active_reply") ||
      reply(replyingToActive[1], true)
    );
  if (input.includes("Fixture B runs an unrelated turn")) {
    verifyInstructions(body);
    native.resumedInstruction = true;
  }
  if (
    input.startsWith("Claudex thread_chat message ") &&
    input.includes("Fixture question body")
  ) {
    assert.match(input, /Peer request\. If it asks a question/);
    assert.match(input, /reply now when you have enough facts/);
    assert.match(
      input,
      /use as many tool calls as needed to establish the answer/,
    );
    assert.match(
      input,
      /Send the reply directly without waiting for a separate user instruction, authorization, or approval/,
    );
    assert.match(input, /approvals required for the work needed to answer/);
    assert.ok(
      input.includes(`the ${mcpServerName} MCP server's thread_chat tool`),
    );
    assert.ok(input.includes(`replyTo "${native.ack.messageId}"`));
    assert.doesNotMatch(input, /Peer reply\. Use it to continue/);
    native.asks++;
  }
  if (
    input.startsWith("Claudex thread_chat message ") &&
    input.includes("Fixture late reply body")
  ) {
    verifyReplyPrompt(body, "Fixture late reply body");
    native.replies++;
  }
  return turnText("Fixture native answer");
});

await Promise.all([mkdir(cwd), mkdir(backend.dataDir)]);
await Promise.all([
  writeFile(join(cwd, "AGENTS.md"), "Fixture local AGENTS.md marker"),
  writeFile(join(cwd, "CLAUDE.md"), "Fixture native CLAUDE.md marker"),
  writeFile(
    join(backend.dataDir, "CLAUDE.md"),
    "Fixture user CLAUDE.md marker",
  ),
  writeFile(join(cwd, "project-label.txt"), projectLabel),
]);
await writeFile(
  config.backendsFile,
  JSON.stringify({
    version: 2,
    backends: [backend],
    providers: [
      {
        id: "fixture",
        backendId: "claude",
        name: "Fixture",
        protocol: "messages_compatible",
        baseUrl: service.url,
        apiKey: "fixture-key",
        models: ["fixture-model"],
      },
    ],
  }),
  { mode: 0o600 },
);
const { socket } = workerLocation(backend);
function launch() {
  const worker = spawn(
    process.execPath,
    [
      new URL(
        "../../server/src/backends/claude/worker-server.mjs",
        import.meta.url,
      ).pathname,
      socket,
      backend.stateDir,
    ],
    {
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        ENABLE_TOOL_SEARCH: "true",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  return { worker, exit: once(worker, "exit") };
}
let worker = launch();
let bridge;
let seq = 0;

async function until(check, description) {
  for (let attempt = 0; attempt < 800; attempt++) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`等待超时：${description}`);
}

async function connect() {
  const manager = createConversationManager({ configDir: root, retryMs: 50 });
  await manager.start();
  let adapter;
  const { callConversationTool } = manager.bindBackend(
    backend,
    () => adapter?.ready && adapter.conversationManager,
  );
  adapter = createClaudeWorkerAdapter({
    backend,
    config,
    broadcast: (event) => events.push(event),
    send: (client, message) => client.deliver(message),
    callConversationTool(context, name, args) {
      native.calls.push({ context, name, args });
      return callConversationTool(context, name, args);
    },
  });
  await adapter.connect();
  manager.wake();
  return { manager, adapter, callConversationTool };
}
const call = (method, params) =>
  new Promise((resolve, reject) =>
    bridge.adapter.receive(
      {
        deliver(message) {
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        },
      },
      { id: ++seq, method, params },
    ),
  );
const chat = (threadId, args) =>
  bridge.callConversationTool({ threadId }, "thread_chat", args);
const start = (threadId, text) =>
  call("turn/start", {
    threadId,
    input: turnText(text),
  });
const activities = async (id) =>
  (await bridge.manager.listActivity()).activities.find(
    ({ threadId }) => threadId === "backend:claude:" + id,
  )?.activities ?? [];
const completed = (id) =>
  until(
    () =>
      events.find(
        (event) =>
          event.method === "turn/completed" && event.params.turn.id === id,
      ),
    "Claude 轮次结束",
  );
async function create(title) {
  const { thread } = await call("thread/start", {
    cwd,
    model: "fixture-model",
    providerId: "fixture",
  });
  await completed(
    (await start(thread.id, `Fixture initialize ${title}`)).turn.id,
  );
  await call("thread/name/set", { threadId: thread.id, name: title });
  return thread.id;
}

try {
  await until(
    async () => (await lstat(socket).catch(() => null))?.isSocket(),
    "独立进程 IPC 就绪",
  );
  bridge = await connect();
  const a = await create("Fixture A");
  verifyInstructions(native.initialRequest);
  const b = await create("Fixture B");
  await completed((await start(a, localCheck)).turn.id);
  assert.equal(native.localRead, true);
  assert.deepEqual(native.calls, []);
  await start(b, "Fixture keep B active");
  await until(() => busy, "B 正在执行");
  await completed((await start(a, coordination)).turn.id);
  assert.equal(native.toolSearchLoadedCoordination, true);
  assert.equal(native.ack?.status, "accepted");
  const question = await until(
    async () =>
      (await chat(b, { action: "inbox" })).messages.find(
        (message) =>
          message.messageId === native.ack.messageId &&
          message.status === "accepted" &&
          message.receipt.reason,
      ),
    "B 忙碌时保留待投递消息",
  );
  assert.equal(native.asks, 0);
  assert.deepEqual(await activities(a), ["collaborating", "waitingForPeer"]);
  const senderTool = native.calls.find((item) => item.args.action === "send");
  assert.deepEqual(senderTool.context, { threadId: a });
  assert.equal(
    (await chat(a, { action: "status", messageId: question.messageId })).replies
      .length,
    0,
  );

  const workerPid = bridge.adapter.workerPid;
  bridge.adapter.close();
  await bridge.manager.close();
  bridge = await connect();
  assert.equal(bridge.adapter.workerPid, workerPid);
  hold.resolve();
  await until(
    async () =>
      (await chat(a, { action: "status", messageId: question.messageId }))
        .status === "delivered",
    "问题原生投递",
  );
  await completed(question.messageId);
  assert.deepEqual(await activities(a), ["waitingForPeer"]);

  await bridge.adapter.shutdown();
  bridge.adapter.close();
  await bridge.manager.close();
  await worker.exit;
  worker = launch();
  await until(
    async () => (await lstat(socket).catch(() => null))?.isSocket(),
    "冷启动 Claude 执行进程",
  );
  bridge = await connect();
  assert.notEqual(bridge.adapter.workerPid, workerPid);
  assert.deepEqual(await activities(a), ["waitingForPeer"]);

  await completed((await start(b, "Fixture B runs an unrelated turn")).turn.id);
  assert.equal(native.resumedInstruction, true);
  await completed(
    (await start(b, `Fixture B replies to ${question.messageId}`)).turn.id,
  );
  const reply = await until(
    async () =>
      (
        await chat(a, { action: "status", messageId: question.messageId })
      ).replies.find((record) => record.status === "delivered"),
    "延迟回复原生投递",
  );
  assert.equal(reply.replyTo, question.messageId);
  await completed(reply.messageId);
  await until(async () => !(await activities(a)).length, "回复完成后退出活动");
  assert.equal(native.asks, 1);
  assert.equal(native.replies, 1);
  const replyTool = native.calls.find((item) => item.args.action === "reply");
  assert.deepEqual(replyTool.context, { threadId: b });
  for (const [threadId, messageId, authorLabel] of [
    [b, question.messageId, "Fixture A"],
    [a, reply.messageId, "Fixture B"],
  ]) {
    const { thread } = await call("thread/read", {
      threadId,
      includeTurns: true,
    });
    const items = thread.turns.flatMap((turn) => turn.items);
    assert.equal(
      items.find((item) => item.id === messageId && item.type === "userMessage")
        ?.authorLabel,
      authorLabel,
    );
    assert.ok(
      items.some(
        (item) =>
          item.type === "agentMessage" && item.text === "Fixture native answer",
      ),
    );
  }

  const { turn: continuing } = await start(a, activeWork);
  await until(
    async () =>
      (
        await lstat(join(cwd, ".active-work-ready")).catch(() => null)
      )?.isFile(),
    "A 的原生工具开始执行",
  );
  await completed(
    (await start(b, `Fixture B active reply to ${question.messageId}`)).turn.id,
  );
  const incoming = await until(
    () =>
      events.find(
        (event) =>
          event.method === "item/completed" &&
          event.params.threadId === a &&
          event.params.turnId === continuing.id &&
          event.params.item.type === "userMessage" &&
          JSON.stringify(event.params.item.content).includes(activeReplyBody),
      ),
    "回复已进入 A 的原轮次输入队列",
  );
  assert.equal(native.activeReplyVisible, undefined);
  assert.ok(
    !events.some(
      (event) =>
        event.method === "turn/completed" &&
        event.params.turn.id === continuing.id,
    ),
  );
  // Round-trip through the same native stdin before releasing the fixture tool.
  await call("config/read", { threadId: a });
  await writeFile(releaseActiveWork, "");
  const original = await completed(continuing.id);
  assert.equal(original.params.turn.status, "completed");
  assert.equal(native.activeReplyVisible, true);
  const activeMessage = incoming.params.item.id;
  const acceptance = await until(async () => {
    const record = await chat(b, {
      action: "status",
      messageId: activeMessage,
    });
    return record.status === "delivered" && record;
  }, "B 查到 A 的原生回复接收回执");
  assert.equal(acceptance.receipt.evidence.messageUuid, activeMessage);
  assert.equal(acceptance.replyTo, question.messageId);
  const { thread: continued } = await call("thread/read", {
    threadId: a,
    includeTurns: true,
  });
  const reconstructed = continued.turns.find(
    (turn) => turn.id === continuing.id,
  );
  assert.equal(
    reconstructed.items.find((item) => item.id === activeMessage)?.authorLabel,
    "Fixture B",
  );
  assert.ok(!continued.turns.some((turn) => turn.id === activeMessage));
  assert.ok(
    !native.calls.some(
      (item) =>
        item.context.threadId === a &&
        ["status", "inbox"].includes(item.args.action),
    ),
  );

  const trustedCalls = native.calls.length;
  await completed((await start(a, "Fixture delegate identity check")).turn.id);
  assert.equal(native.calls.length, trustedCalls);
  assert.equal(native.childDenial?.is_error, true);
  assert.match(JSON.stringify(native.childDenial.content), /请由主会话调用/);
  console.log(
    JSON.stringify({
      runtime: execFileSync(cli, ["--version"], { encoding: "utf8" }).trim(),
      tools: Object.values(toolNames),
      busyDeferral: true,
      workerRetainedAcrossBridgeRestart: true,
      coldIdleTargetRestored: true,
      nativeDeliveries: [native.asks, native.replies],
      recoveredPeerAttribution: true,
      nativeSubagentIdentityIsolated: true,
      collaborationGuidanceBeforeToolSearch: true,
      localInstructionsPreserved: true,
      readOnlyLocalWorkDidNotSend: true,
      collaborationGuidanceRestoredOnResume: true,
      sameTurnReplyAfterNativeTool: true,
      activeReplyReadWithoutPolling: true,
      nativePeerRequestAndReplyGuidance: true,
      peerWaitPersistsUntilReply: true,
    }),
  );
} finally {
  hold.resolve();
  await writeFile(releaseActiveWork, "").catch(() => {});
  bridge?.adapter.close();
  await bridge?.manager.close();
  worker.worker.kill("SIGTERM");
  await worker.exit;
  await service.close();
  await rm(root, { recursive: true, force: true });
}

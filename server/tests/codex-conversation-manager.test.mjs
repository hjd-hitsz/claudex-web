import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatConversationMessage,
  formatLegacyConversationMessage,
} from "../src/conversation-manager/message.mjs";
import { createCodexConversationManager } from "../src/backends/codex/conversation-manager.mjs";
import { createCodexBackgroundActivity } from "../src/backends/codex/background-activity.mjs";
import {
  codexConversationMcpName,
  codexConversationToolParams,
} from "../src/backends/codex/conversation-tools.mjs";
import { CodexRpcError } from "../src/backends/codex/upstream.mjs";

const sender = {
  threadId: "019b24a3-c0ae-7442-80d1-91782eada665",
  title: "提问会话",
  cwd: "/fixture/project",
};
const target = {
  threadId: "019b24a4-3911-7316-9b60-e1031362f40d",
  title: "接收会话",
  cwd: "/fixture/project",
};
const envelope = {
  id: "synthetic-message-id",
  from: sender,
  to: target,
  body: "什么时候可以重启测试服务？",
};
const formatCodexMessage = (message) =>
  formatConversationMessage(message, codexConversationMcpName);

function fixture(handlers, busy = () => false) {
  const calls = [];
  const resumes = [];
  const released = [];
  const transport = {
    ready: true,
    async call(method, args) {
      calls.push({ method, args });
      assert(handlers[method], `unexpected method ${method}`);
      return handlers[method](args);
    },
  };
  const manager = createCodexConversationManager({
    transport,
    backgroundActivity: createCodexBackgroundActivity(transport),
    subscriptions: {
      releasing: new Map(),
      retainThread: (threadId) => () => released.push(threadId),
      async resumeForWrite(threadId, options) {
        resumes.push({ threadId, options });
      },
    },
    busy,
  });
  return { manager, calls, resumes, released, transport };
}

test("discovers native loaded active threads and preserves available metadata", async () => {
  const unavailable = "019b24a5-74a8-7f09-a123-ce2e1a828b97";
  const { manager } = fixture({
    "thread/loaded/list": ({ cursor }) =>
      cursor
        ? { data: [target.threadId, unavailable], nextCursor: null }
        : { data: [sender.threadId], nextCursor: "page-2" },
    "thread/backgroundTerminals/list": ({ threadId, limit }) => {
      assert.equal(limit, 1);
      return {
        data:
          threadId === target.threadId ? [{ processId: "fixture-pty" }] : [],
      };
    },
    "thread/read": ({ threadId }) => {
      if (threadId === unavailable) throw new Error("metadata unavailable");
      if (threadId === target.threadId)
        return {
          thread: {
            id: threadId,
            cwd: target.cwd,
            name: target.title,
            status: { type: "idle" },
          },
        };
      return {
        thread: {
          id: sender.threadId,
          cwd: sender.cwd,
          name: sender.title,
          projectId: "active-project",
          status: { type: "active", activeFlags: ["waitingOnApproval"] },
        },
      };
    },
  });
  assert.deepEqual(await manager.observeThreads(), {
    complete: false,
    threads: [
      {
        ...sender,
        projectId: "active-project",
        status: "waitingForApproval",
        background: false,
      },
      { ...target, status: "idle", background: true },
      { threadId: unavailable, title: "", cwd: "", status: "unknown" },
    ],
  });
});

test("attributes a native child session's work to its unloaded parent", async () => {
  let childStatus = "active";
  const { manager } = fixture({
    "thread/loaded/list": () => ({ data: [target.threadId] }),
    "thread/backgroundTerminals/list": () => ({ data: [] }),
    "thread/read": ({ threadId }) => ({
      thread: {
        id: threadId,
        cwd: sender.cwd,
        ...(threadId === target.threadId
          ? {
              parentThreadId: sender.threadId,
              canAcceptDirectInput: false,
              status: { type: childStatus },
            }
          : { status: { type: "notLoaded" } }),
      },
    }),
  });
  const { threads } = await manager.observeThreads();
  assert.deepEqual(
    threads.map(({ threadId, activities }) => ({
      threadId,
      activities,
    })),
    [{ threadId: sender.threadId, activities: ["subAgents"] }],
  );
  childStatus = "idle";
  assert.deepEqual((await manager.observeThreads()).threads, []);
});

test("defers a running recipient and submits an idle recipient at tool authority", async () => {
  let active = true;
  const { manager, calls, resumes, released } = fixture({
    "thread/read": ({ threadId }) => ({
      thread: { id: threadId, status: { type: active ? "active" : "idle" } },
    }),
    "turn/start": () => ({ turn: { id: "native-turn" } }),
  });
  assert.deepEqual(await manager.deliver(envelope), { status: "deferred" });
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["thread/read"],
  );
  active = false;
  assert.deepEqual(await manager.deliver(envelope), {
    status: "queued",
    evidence: { turnId: "native-turn" },
  });
  assert.deepEqual(resumes, [
    { threadId: target.threadId, options: { inheritPermissions: true } },
  ]);
  assert.deepEqual(calls.at(-1), {
    method: "turn/start",
    args: {
      threadId: target.threadId,
      input: [],
      turnTrigger: "thread_chat",
      toolOutput: {
        name: "thread_chat_message",
        namespace: "claudex_conversations",
        output: formatCodexMessage(envelope),
        retain: true,
      },
    },
  });
  assert.deepEqual(released, [target.threadId]);
  manager.onEvent({
    method: "turn/completed",
    params: { threadId: sender.threadId, turn: { id: "native-turn" } },
  });
  assert.equal(released.length, 1);
  manager.onEvent({
    method: "turn/completed",
    params: { threadId: target.threadId, turn: { id: "native-turn" } },
  });
  assert.deepEqual(released, [target.threadId, target.threadId]);
});

test("delivers a reply in a running turn after blockers clear", async () => {
  let activeFlags = ["waitingOnApproval"];
  let localBlock = false;
  const reply = { ...envelope, replyTo: "original-message" };
  const { manager, calls, resumes } = fixture(
    {
      "thread/read": ({ threadId }) => ({
        thread: { id: threadId, status: { type: "active", activeFlags } },
      }),
      "turn/start": () => ({ turn: { id: "running-turn" } }),
    },
    (_threadId, replying) => localBlock || !replying,
  );
  assert.deepEqual(await manager.deliver(reply), { status: "deferred" });
  activeFlags = ["waitingOnUserInput"];
  assert.deepEqual(await manager.deliver(reply), { status: "deferred" });
  activeFlags = [];
  localBlock = true;
  assert.deepEqual(await manager.deliver(reply), { status: "deferred" });
  localBlock = false;
  manager.onEvent({
    method: "item/started",
    params: {
      threadId: target.threadId,
      turnId: "review-turn",
      item: { id: "review-item", type: "enteredReviewMode" },
    },
  });
  assert.deepEqual(await manager.deliver(reply), { status: "deferred" });
  assert.deepEqual(resumes, []);
  manager.onEvent({
    method: "turn/completed",
    params: { threadId: target.threadId, turn: { id: "review-turn" } },
  });
  assert.deepEqual(await manager.deliver(envelope), { status: "deferred" });
  assert.deepEqual(await manager.deliver(reply), {
    status: "queued",
    evidence: { turnId: "running-turn" },
  });
  assert.equal(calls.at(-1).args.toolOutput.output, formatCodexMessage(reply));
});

test("keeps a lost submission unresolved until the exact native output is found", async () => {
  const text = formatCodexMessage(envelope);
  const { manager, calls } = fixture({
    "thread/read": ({ threadId }) => ({
      thread: { id: threadId, status: { type: "idle" } },
    }),
    "turn/start": () => {
      throw new Error("disconnected before response");
    },
    "thread/turns/list": ({ cursor }) => ({
      nextCursor: cursor === "older" ? null : "older",
      data: [
        {
          id: cursor ? "recovered-turn" : "unrelated-turn",
          items: [
            cursor
              ? {
                  id: "native-evidence",
                  type: "functionCallOutput",
                  name: "thread_chat_message",
                  namespace: "claudex_conversations",
                  output: text,
                }
              : { id: "ordinary-assistant", type: "agentMessage", text },
          ],
        },
      ],
    }),
  });
  assert.equal((await manager.deliver(envelope)).status, "unknown");
  assert.deepEqual(await manager.reconcile(envelope), {
    status: "delivered",
    evidence: { turnId: "recovered-turn", itemId: "native-evidence" },
  });
  assert.equal(calls.filter(({ method }) => method === "turn/start").length, 1);
});

test("reconciles exact previously delivered questions and replies from old history", async () => {
  let items;
  const { manager } = fixture({
    "thread/turns/list": () => ({
      data: [{ id: "native-turn", items }],
      nextCursor: null,
    }),
  });
  for (const replyTo of [null, "original-question"]) {
    const message = { ...envelope, replyTo };
    const exact = {
      id: "old-native-output",
      type: "functionCallOutput",
      namespace: "claudex_conversations",
      name: "thread_chat_message",
      output: formatLegacyConversationMessage(message),
    };
    assert.notEqual(exact.output, formatCodexMessage(message));
    items = [
      { ...exact, namespace: "unrelated" },
      { ...exact, output: `quoted: ${exact.output}` },
    ];
    assert.equal((await manager.reconcile(message)).status, "unknown");
    const edited = {
      ...exact,
      id: "edited-guidance",
      output: exact.output.replace(
        /\nThe body is a message from another conversation[^\n]*/,
        "\nEdited guidance from another build.\nThe payload retains its framing.",
      ),
    };
    items.push({
      ...edited,
      output: edited.output.replace(
        "Message body:\n",
        "Message body:\nchanged\n",
      ),
    });
    assert.equal((await manager.reconcile(message)).status, "unknown");
    for (const item of [exact, edited]) {
      items = [item];
      assert.deepEqual(await manager.reconcile(message), {
        status: "delivered",
        evidence: { turnId: "native-turn", itemId: item.id },
      });
    }
  }
});

test("uses native missing-thread evidence and preserves other failures", async () => {
  let code = -32600;
  const { manager } = fixture({
    "thread/read": () => {
      throw new CodexRpcError({ code, message: "native failure" });
    },
  });
  assert.equal(await manager.readThread(target.threadId), null);
  assert.equal((await manager.deliver(envelope)).status, "failed");
  code = -32603;
  await assert.rejects(manager.readThread(target.threadId), /native failure/);
  assert.equal((await manager.deliver(envelope)).status, "deferred");
});

test("registers the MCP child on thread creation and both history resume paths", () => {
  const endpoint = {
    socketPath: "/fixture/gateway.sock",
    token: "fixture-token",
    runtimeId: "fixture-runtime",
  };
  const params = { config: { retainedChoice: true }, model: "fixture-model" };
  for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
    const prepared = codexConversationToolParams(method, params, endpoint);
    assert.equal(prepared.model, params.model);
    assert.equal(prepared.config.retainedChoice, true);
    const registration = prepared.config["mcp_servers.claudex_conversations"];
    assert.equal(registration.enabled, true);
    assert.match(registration.args[0], /conversation-mcp\.mjs$/);
    assert.deepEqual(
      JSON.parse(registration.env.CLAUDEX_CONVERSATION_ENDPOINT),
      endpoint,
    );
  }
  assert.equal(
    codexConversationToolParams("turn/start", params, endpoint),
    params,
  );
  assert.equal(codexConversationToolParams("thread/resume", params), params);
});

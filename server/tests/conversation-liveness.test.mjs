import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createConversationManager } from "../src/conversation-manager/manager.mjs";
import { runtimeIdentity } from "../src/conversation-manager/address.mjs";
import {
  createDelegationActivity,
  nativeDelegationStatePath,
} from "../src/backends/delegation/activity.mjs";
import { agySessionStatePath } from "../src/backends/agy/session-store.mjs";
import { writePrivateFile } from "../src/private-file.mjs";

test("会话活动统一覆盖执行、维护、目标、进程、委派和协作", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "claudex-liveness-"));
  const backend = { id: "codex", type: "codex", dataDir: configDir };
  const sourceRuntime = runtimeIdentity(backend);
  const workspace = "/fixture/workspace";
  const caller = { threadId: "caller", title: "观察会话", cwd: workspace };
  const parent = { threadId: "parent", title: "主会话", cwd: workspace };
  let runtime = {};
  let native = [];
  let delivery = "deferred";
  const manager = createConversationManager({
    configDir,
    retryMs: 10,
    readRuntime: () => runtime,
    readDelegations: createDelegationActivity(configDir, () => true),
  });
  t.after(async () => {
    await manager.close();
    await rm(configDir, { recursive: true, force: true });
  });
  await manager.start();
  const bound = manager.bindBackend(backend, () => adapter);
  const adapter = {
    observeThreads: async () => ({ threads: native, complete: true }),
    readThread: async (id) =>
      [parent, caller].find(({ threadId }) => id === threadId),
    deliver: async () => ({ status: delivery }),
    reconcile: async () => ({ status: delivery }),
  };
  const list = () =>
    bound.callConversationTool(
      { threadId: caller.threadId },
      "list_active_threads",
      {},
    );
  const web = async (id = "parent") =>
    (await manager.listActivity()).activities.find(
      ({ threadId }) => threadId === id,
    );
  const check = async (activity) => {
    const result = await web();
    const { threads, complete } = await list();
    assert.equal(complete, true);
    if (!activity) {
      assert.equal(result, undefined);
      assert.equal(
        threads.some(({ title }) => title === parent.title),
        false,
      );
      return;
    }
    assert.equal(result.live, true);
    assert.equal(result.status, activity);
    assert.ok(result.activities.includes(activity));
    assert.equal(
      threads.find(({ title }) => title === parent.title)?.status,
      activity,
    );
  };
  const facts = [
    ["running", { activeTurns: { parent: "turn" } }],
    [
      "waitingForApproval",
      {
        questions: [
          {
            method: "item/permissions/requestApproval",
            params: { threadId: "parent" },
          },
        ],
      },
    ],
    [
      "waitingForInput",
      {
        questions: [
          {
            method: "item/tool/requestUserInput",
            params: { threadId: "parent" },
          },
        ],
      },
    ],
    ["compacting", { compactions: { parent: { status: "running" } } }],
    ["queued", { queuedInputs: { parent: "queued-turn" } }],
  ];
  for (const [type, value] of facts) {
    runtime = value;
    await check(type);
    runtime = {};
    await check();
  }
  for (const [method, params, expected] of [
    ["item/tool/requestUserInput", {}, "waitingForInput"],
    ["mcpServer/elicitation/request", { mode: "form" }, "waitingForInput"],
    ["mcpServer/elicitation/request", { mode: "url" }, "waitingForInput"],
    [
      "mcpServer/elicitation/request",
      { mode: "form", _meta: { codex_approval_kind: "mcp_tool_call" } },
      "waitingForApproval",
    ],
    ["lan/agy/permission", {}, "waitingForApproval"],
  ]) {
    const question = {
      method,
      params: {
        ...params,
        delegationTaskId: "delegated",
        executorName: "Claude Code",
      },
    };
    runtime = {
      questions: [
        { ...question, params: { ...question.params, threadId: "parent" } },
        {
          ...question,
          params: { ...question.params, threadId: "backend:agy:secretary" },
        },
      ],
    };
    await check(expected);
    assert.deepEqual((await web("backend:agy:secretary")).activities, [
      expected,
    ]);
    runtime = {};
    await check();
  }
  const firstRevert = Promise.withResolvers();
  const secondRevert = Promise.withResolvers();
  const undo = manager.trackRevert(parent.threadId, () => firstRevert.promise);
  const undoFailure = assert.rejects(
    manager.trackRevert(parent.threadId, () => secondRevert.promise),
    /workspace changed/,
  );
  await check("reverting");
  firstRevert.resolve();
  await undo;
  await check("reverting");
  secondRevert.reject(new Error("workspace changed"));
  await undoFailure;
  await check();
  for (const type of ["queued", "goal", "background", "subAgents"]) {
    native = [{ ...parent, status: "idle", activities: [type] }];
    await check(type);
    native = [];
    await check();
  }
  const nativePath = nativeDelegationStatePath(configDir);
  const agyPath = agySessionStatePath(join(configDir, "backends", "agy"));
  await Promise.all(
    [nativePath, agyPath].map((path) =>
      mkdir(dirname(path), { recursive: true }),
    ),
  );
  async function delegation(status, deliveryStatus, owner = sourceRuntime) {
    const task = {
      id: "task",
      parentId: "parent",
      sourceRuntime: owner,
      status,
      steps: [{ id: "step" }],
    };
    const notices = deliveryStatus
      ? {
          notice: {
            taskId: "task",
            stepId: "step",
            kind: "result",
            status: deliveryStatus,
          },
        }
      : {};
    await writePrivateFile(
      nativePath,
      JSON.stringify({ tasks: { task }, notices }),
    );
  }
  for (const status of ["accepted", "starting", "running", "waiting"])
    await delegation(status).then(() => check("delegating"));
  await delegation("running", null, "other-runtime");
  await check();
  await delegation("completed", "queued");
  await check("delegating");
  await delegation("completed", "submitting");
  await check("delegating");
  runtime = { activeTurns: { parent: "return-turn" } };
  assert.deepEqual((await web()).activities, ["running", "delegating"]);
  await delegation("completed", "delivered");
  await check("running");
  runtime = {};
  await check();

  const task = { id: "agy-task", parentId: "secretary", status: "running" };
  await writeFile(
    agyPath,
    JSON.stringify({
      tasks: { task },
      notices: {},
      sessions: { secretary: {} },
    }),
  );
  assert.equal((await web("backend:agy:secretary")).status, "delegating");
  await writePrivateFile(
    agyPath,
    JSON.stringify({
      tasks: { task },
      notices: {},
      sessions: { secretary: { archived: true } },
    }),
  );
  assert.equal(await web("backend:agy:secretary"), undefined);
  await check();

  native = [
    { ...parent, status: "running" },
    { ...caller, status: "running" },
  ];
  const parentAddress = (await list()).threads[0].threadId;
  const chat = (thread, args) =>
    bound.callConversationTool({ threadId: thread }, "thread_chat", args);
  const inquiry = await chat("caller", {
    action: "send",
    threadId: parentAddress,
    requestId: "question",
    body: "何时交付？",
    expectReply: true,
  });
  native = [];
  assert.deepEqual((await web("caller")).activities, [
    "collaborating",
    "waitingForPeer",
  ]);
  await check("collaborating");
  delivery = "delivered";
  manager.wake();
  async function settled(id) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        (await chat("caller", { action: "status", messageId: id })).status ===
        "delivered"
      )
        return;
      await delay(10);
    }
    assert.fail("等待会话消息回执超时");
  }
  await settled(inquiry.messageId);
  assert.equal((await web("caller")).status, "waitingForPeer");
  await check();
  const reply = await chat("parent", {
    action: "reply",
    replyTo: inquiry.messageId,
    requestId: "answer",
    body: "已经完成。",
  });
  await settled(reply.messageId);
  assert.equal(await web("caller"), undefined);

  const dismissed = await chat("caller", {
    action: "send",
    threadId: parentAddress,
    requestId: "dismissed",
    body: "可异步确认",
    expectReply: true,
  });
  await settled(dismissed.messageId);
  assert.equal((await web("caller")).status, "waitingForPeer");
  await chat("caller", {
    action: "stop_waiting",
    messageId: dismissed.messageId,
  });
  assert.equal(await web("caller"), undefined);
});

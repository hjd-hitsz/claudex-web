import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { readRolloutTrace } from "../src/backends/codex/rollout-tools.mjs";
import {
  resultNoticePayload,
  turnCalls,
} from "../src/backends/delegation/call-chain.mjs";
import { readDelegationStep } from "../src/backends/delegation/step-details.mjs";
import { acceptDelegation } from "../src/backends/delegation/delegation-store.mjs";
import { traceId } from "../src/backends/delegation/trace-ids.mjs";
import { delegationSummaries } from "../src/backends/delegation/delivery-summary.mjs";
import {
  delegationHistoryEvent,
  isDelegationHistoryEvent,
} from "../src/backends/delegation/delegation-history.mjs";
import {
  delegationStage,
  delegationResults,
  summarizeDelegationStages,
  traceVersion,
} from "../src/backends/delegation/delegation-results.mjs";
import { formatConversationMessage } from "../src/conversation-manager/message.mjs";
import {
  convertMessage,
  historyTurns,
} from "../src/backends/claude/messages.mjs";
import {
  mapResult,
  mapNotification,
} from "../src/backends/identity-mapping.mjs";

test("委派通知在实时和历史投影中成为结果卡片，并保留真正的模型正文", () => {
  const id = "567e3144-0000-4000-8000-000000000001";
  const legacy = formatConversationMessage({
    id,
    from: { title: "Codex" },
    delegation: true,
    body: JSON.stringify({
      task_id: "12345678-0000-4000-8000-000000000001",
      stepId: id,
      status: "completed",
      context: { usedTokens: 120, totalTokens: 200, compactCount: 0 },
      answer:
        "**阶段说明**\n\n正在核对\n\n**最终结论**\n\n`extend()` 执行步进。",
      callChain: [],
    }),
  });
  const prompt = { type: "user", uuid: id, message: { content: legacy } };
  const peer = { ...prompt, origin: { kind: "peer", name: "Codex" } };
  const answer = {
    type: "assistant",
    uuid: "answer",
    message: {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "核对后的模型正文" }],
    },
  };
  const card = {
    id,
    turnId: id,
    type: "delegationResult",
    taskId: "12345678",
    stepId: "567e3144",
    preview: "extend() 执行步进。",
    target: "codex",
    status: "completed",
    context: { usedTokens: 120, totalTokens: 200, compactCount: 0 },
  };
  const projected = historyTurns([peer, answer])[0].items;
  assert.deepEqual(projected[0], card);
  assert.equal(projected[1].phase, "final_answer");
  assert.equal(projected[1].text, answer.message.content[0].text);
  assert.equal(convertMessage(prompt, id)[0].type, "userMessage");
  const compact = formatConversationMessage({
    id,
    displayId: id.slice(0, 8),
    from: { title: "Codex" },
    delegation: true,
    body: JSON.stringify({
      task_id: "12345678",
      stepId: id.slice(0, 8),
      status: "completed",
      context: card.context,
      answer: "**extend() 执行步进。**",
    }),
  });
  assert.deepEqual(
    convertMessage({ ...peer, message: { content: compact } }, id),
    [card],
  );
  const tool = {
    id,
    turnId: id,
    type: "functionCallOutput",
    namespace: "claudex_conversations",
    name: "thread_chat_message",
    output: legacy,
  };
  assert.deepEqual(
    mapResult({ data: [{ item: tool }] }, "codex", "thread/items/list").data[0]
      .item,
    card,
  );
  assert.deepEqual(
    mapNotification(
      { method: "item/completed", params: { item: tool } },
      "codex",
    ).params.item,
    card,
  );
  const ordinaryTool = { ...tool, namespace: "other" };
  assert.deepEqual(
    mapResult({ data: [{ item: ordinaryTool }] }, "codex", "thread/items/list")
      .data[0].item,
    ordinaryTool,
  );
});

test("业务摘要按步骤关联标题与最终结论，原生用量通知沿委派对话路由", () => {
  const old = {
    id: "legacy",
    request:
      "只读调查任务：检查路径规划（/workspace/plan）中的扩展。\n请核对实现。",
    result: {
      answer:
        "**阶段说明**\n\n开始读取\n\n**最终结论**\n\n**`extend()` 执行步进。**",
    },
  };
  const next = {
    id: "next",
    taskSummary: "核对扩展步长",
    request: "记录每轮阶段说明",
    result: {
      answer: "过程全文",
      conclusion: "路径步长由索引决定。".repeat(10),
    },
  };
  const cards = delegationSummaries([old, next]);
  assert.deepEqual(cards.legacy, {
    title: "检查路径规划中的扩展",
    preview: "extend() 执行步进。",
  });
  assert.equal(cards.next.title, next.taskSummary);
  assert.equal(cards.next.preview.length, 78);
  assert(cards.next.preview.endsWith("..."));
  const event = {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "native",
      turnId: "turn",
      tokenUsage: { last: { totalTokens: 12 } },
    },
  };
  assert(isDelegationHistoryEvent(event));
  assert.deepEqual(delegationHistoryEvent({ id: "task" }, event), {
    ...event,
    params: { ...event.params, threadId: "delegation/task" },
  });
});

test("命令字段和 exec 脚本保留完整命令，旧回投记录使用精简调用结构", () => {
  const long = "printf '%s' " + "x".repeat(280);
  const payloads = [
    {
      name: "exec",
      input: JSON.stringify({ description: "核对版本", command: long }),
    },
    {
      name: "exec",
      input:
        'const commands = ["git status --short", "npm run version:check"]; text(await Promise.all(commands.map(cmd => tools.exec_command({ cmd }))));',
    },
    {
      name: "exec",
      input:
        'const prefix = "printf "; await tools.exec_command({cmd: `${prefix}ok`});',
    },
    {
      name: "exec",
      input: "const cmd = load('command'); await tools.exec_command({ cmd });",
    },
    {
      type: "local_shell_call",
      action: { type: "exec", command: ["/bin/sh", "-c", "printf 'a b'"] },
    },
    { name: "apply_patch", input: "*** Begin Patch" },
  ];
  const rawCalls = new Map(
    payloads.map((payload, i) => {
      const callId = "call_native_result_" + i;
      return [callId, { callId, input: { payload }, returned: true }];
    }),
  );
  const turn = {
    id: "90000000-0000-4000-8000-000000000001",
    items: [
      {
        id: "claude-tool-use-1",
        type: "commandExecution",
        command: "npm test",
      },
    ],
  };
  const positions = new Map(
    [...rawCalls.keys(), turn.items[0].id].map((id, sequence) => [
      id,
      { time: sequence, sequence },
    ]),
  );
  const calls = turnCalls(turn, { calls: rawCalls, positions }, "claude");
  assert.deepEqual(
    calls.map(({ action }) => action),
    [
      long,
      "git status --short\nnpm run version:check",
      "printf ok",
      undefined,
      "/bin/sh -c 'printf '\\''a b'\\'''",
      undefined,
      "npm test",
    ],
  );
  assert.equal(calls[3].script, payloads[3].input);
  const notice = resultNoticePayload({
    stepId: "a0000000-0000-4000-8000-000000000001",
    callChain: calls.map((call) => ({
      ...call,
      turnId: turn.id,
      source: "rollout",
    })),
    turns: [{ turnId: turn.id, status: "completed", triggers: [] }],
  });
  assert.equal(notice.stepId, "a0000000");
  assert.equal(notice.turns[0].callCount, calls.length);
  assert(notice.callChain.every((call) => /^[a-f0-9]{8}$/.test(call.callId)));
  assert(
    notice.callChain.every(
      (call) =>
        !Object.hasOwn(call, "turnId") && !Object.hasOwn(call, "source"),
    ),
  );
  assert.equal(
    new Set(notice.callChain.map(({ callId }) => callId)).size,
    calls.length,
  );
});

test("Codex 原生调用按 Rollout 顺序回投，可按步骤读取原始输入输出", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "claudex-delegation-trace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "rollout.jsonl");
  const taskId = "aced0001-0000-4000-8000-000000000001";
  const stepId = "acff0001-0000-4000-8000-000000000001";
  const shellId = "call_native_shell_1";
  const patchId = "call_native_patch_1";
  const thread = {
    id: "native",
    path,
    turns: [
      {
        id: "first",
        items: [
          {
            type: "commandExecution",
            id: shellId,
            command: "printf done",
            status: "completed",
          },
        ],
      },
      {
        id: "followup",
        items: [{ type: "dynamicToolCall", id: "another", tool: "stat" }],
      },
    ],
  };
  const response = (payload) => ({ type: "response_item", payload });
  const event = (type, turn_id) => ({
    type: "event_msg",
    payload: { type, turn_id },
  });
  const full = "🧪".repeat(11000);
  const raw = [
    { type: "session_meta", payload: { id: thread.id } },
    event("task_started", "first"),
    response({
      type: "function_call",
      name: "exec_command",
      call_id: shellId,
      arguments: '{"cmd":"printf done","max_output_tokens":26}',
    }),
    response({ type: "function_call_output", call_id: shellId, output: full }),
    response({
      type: "custom_tool_call",
      name: "apply_patch",
      call_id: patchId,
      input: "full patch text",
    }),
    {
      type: "event_msg",
      payload: {
        type: "item_started",
        turn_id: "first",
        item: {
          id: patchId,
          type: "fileChange",
          changes: [{ path: "/fixture/added.txt", kind: { type: "add" } }],
        },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "first",
        item: {
          id: patchId,
          type: "FileChange",
          changes: {
            "/fixture/added.txt": { type: "add", content: "added" },
            "/fixture/renamed.txt": {
              type: "update",
              unified_diff: "-before\n+after",
              move_path: "/fixture/moved.txt",
            },
            "/fixture/deleted.txt": { type: "delete", content: "deleted" },
          },
        },
      },
    },
    response({
      type: "custom_tool_call_output",
      call_id: patchId,
      output: "patch complete",
    }),
    response({
      type: "function_call_output",
      call_id: "notice",
      output: "injected by task worker",
    }),
    event("task_complete", "first"),
    event("task_started", "followup"),
    response({
      type: "function_call",
      name: "exec_command",
      call_id: shellId,
      arguments: '{"cmd":"printf other"}',
    }),
    response({
      type: "function_call_output",
      call_id: shellId,
      output: "other step output",
    }),
  ];
  await writeFile(
    path + ".zst",
    zstdCompressSync(raw.map((record) => JSON.stringify(record)).join("\n")),
  );
  const rollout = await readRolloutTrace(thread, new Set(["first"]));
  const chain = turnCalls(thread.turns[0], rollout.get("first"), "codex");
  assert.deepEqual(rollout.get("first").items.get(patchId).changes, [
    { path: "/fixture/added.txt", kind: { type: "add" } },
    {
      path: "/fixture/renamed.txt",
      kind: { type: "update", move_path: "/fixture/moved.txt" },
    },
    { path: "/fixture/deleted.txt", kind: { type: "delete" } },
  ]);
  assert.equal(chain.find(({ callId }) => callId === patchId).fileCount, 3);
  assert.deepEqual(
    chain.map(({ callId, tool }) => [callId, tool]),
    [
      [shellId, "exec_command"],
      [patchId, "apply_patch"],
    ],
  );

  const task = {
    id: taskId,
    parentId: "owner",
    sourceRuntime: "original",
    target: "codex",
    executor: { threadId: "native" },
    steps: [
      {
        id: stepId,
        turnId: "first",
        result: { traceVersion, callChain: chain },
      },
      { id: "follow", turnId: "followup" },
    ],
  };
  const store = { read: async () => ({ tasks: { [taskId]: task } }) };
  let reads = 0;
  const executor = {
    resolve: async () => ({}),
    readHistory: async () => {
      reads++;
      return { thread };
    },
  };
  const owner = { id: "owner", runtimeId: "original" };
  const input = { taskId: "aced0001", stepId: "acff0001" };
  const read = (args, parent = owner) =>
    readDelegationStep(store, executor, parent, { ...input, ...args });
  await assert.rejects(read({}, { ...owner, id: "other" }), /找不到该委派任务/);
  await assert.rejects(
    read({}, { ...owner, runtimeId: "replacement" }),
    /找不到该委派任务/,
  );
  await assert.rejects(read({ stepId: "missing" }), /找不到该步骤/);
  assert.deepEqual(
    (await read({})).result.callChain,
    resultNoticePayload({ callChain: chain }).callChain,
  );
  assert.equal(reads, 0);
  await assert.rejects(read({ callId: "another" }), /找不到指定调用/);
  await assert.rejects(
    read({ callId: traceId(shellId), turnId: "followup" }),
    /找不到指定调用/,
  );
  assert.equal(
    (await read({ callId: traceId(patchId) })).raw.outputs[0].payload.output,
    "patch complete",
  );

  let page = await read({ callId: traceId(shellId) });
  let text = page.chunk;
  while (page.nextOffset !== null) {
    assert(page.chunk.isWellFormed());
    page = await read({ callId: traceId(shellId), offset: page.nextOffset });
    text += page.chunk;
  }
  const detail = JSON.parse(text);
  assert.deepEqual(detail.raw.input, raw[2]);
  assert.deepEqual(detail.raw.outputs, [raw[3]]);
  assert.equal(detail.item.command, "printf done");
  const follow = await read({
    callId: traceId(shellId),
    taskId,
    stepId: "follow",
  });
  assert.equal(follow.raw.outputs[0].payload.output, "other step output");
  assert.equal(
    (await readRolloutTrace({ ...thread, id: "wrong" }, new Set(["first"])))
      .size,
    0,
  );
});

test("Codex 按原生开始时间合并并行命令与外层调用，补齐阶段说明并重建旧结果", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "claudex-delegation-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "rollout.jsonl");
  const turn = {
    id: "turn",
    status: "completed",
    items: [
      { id: "shell2", type: "commandExecution", command: "printf second" },
      {
        id: "conclude",
        type: "agentMessage",
        phase: "final_answer",
        text: "结论",
      },
    ],
  };
  const thread = { id: "native", path, turns: [turn] };
  const response = (ms, payload) => ({
    timestamp: new Date(ms).toISOString(),
    type: "response_item",
    payload: {
      ...payload,
      internal_chat_message_metadata_passthrough: { turn_id: turn.id },
    },
  });
  const message = (ms, id, phase, text) =>
    response(ms, {
      id,
      type: "message",
      role: "assistant",
      phase,
      content: [{ type: "output_text", text }],
    });
  const command = (start, completed, id, text) => ({
    timestamp: new Date(completed).toISOString(),
    type: "event_msg",
    payload: {
      type: "item_completed",
      turn_id: turn.id,
      started_at_ms: start,
      item: {
        id,
        type: "CommandExecution",
        command: text,
        status: "completed",
      },
    },
  });
  const usage = (turnId, used) => ({
    type: "event_msg",
    payload: {
      type: "token_count",
      turn_id: turnId,
      info: {
        total_token_usage: { total_tokens: 350 },
        last_token_usage: { total_tokens: used },
        model_context_window: 200,
      },
    },
  });
  await writeFile(
    path,
    [
      { type: "session_meta", payload: { id: thread.id } },
      message(10, "start", "commentary", "开始检查"),
      response(20, {
        type: "custom_tool_call",
        name: "exec",
        call_id: "wrapper",
        input: "{}",
      }),
      command(40, 60, "shell2", "printf second"),
      command(30, 70, "shell1", "printf first"),
      usage(turn.id, 170),
      {
        type: "compacted",
        payload: { window_id: "compacted-window", message: "" },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turn.id,
          item: { id: "compaction", type: "ContextCompaction" },
        },
      },
      message(80, "progress", "commentary", "已核对命令"),
      response(90, {
        type: "function_call",
        name: "lookup",
        call_id: "lookup",
        arguments: "{}",
      }),
      message(100, "conclude", "final_answer", "结论"),
      usage(turn.id, 80),
      usage("unrelated", 110),
    ]
      .map(JSON.stringify)
      .join("\n"),
  );
  const rollout = await readRolloutTrace(thread, new Set([turn.id]));
  const context = { usedTokens: 80, totalTokens: 200, compactCount: 1 };
  assert.deepEqual(rollout.get(turn.id).context, context);
  const stage = delegationStage(turn, [], "codex", rollout.get(turn.id));
  assert.deepEqual(
    stage.callChain.map(({ callId }) => callId),
    ["wrapper", "shell1", "shell2", "lookup"],
  );
  assert.equal(
    stage.answer,
    "**阶段说明**\n\n开始检查\n\n已核对命令\n\n**最终结论**\n\n结论",
  );
  assert.equal(stage.conclusion, "结论");
  const old = {
    id: "task",
    target: "codex",
    parentId: "parent",
    executor: { threadId: thread.id },
    steps: [
      {
        id: "step",
        turnId: turn.id,
        result: { answer: "结论", callChain: [] },
      },
    ],
  };
  const read = await readDelegationStep(
    { read: async () => ({ tasks: { task: old } }) },
    { resolve: async () => ({}), readHistory: async () => ({ thread }) },
    { id: "parent" },
    { taskId: "task", stepId: "step" },
  );
  assert.deepEqual(
    read.result,
    resultNoticePayload({ ...summarizeDelegationStages([stage]), context }),
  );
  assert.equal(old.steps[0].result.answer, "结论");
});

test("Claude 回投采用当前会话占用并按原生压缩边界计数", () => {
  const earlier = {
    id: "earlier",
    status: "completed",
    items: [{ id: "boundary", type: "contextCompaction" }],
  };
  const turn = {
    id: "latest",
    status: "completed",
    items: [
      { id: "boundary", type: "contextCompaction" },
      { id: "second-boundary", type: "contextCompaction" },
      { type: "agentMessage", text: "完成" },
    ],
  };
  const thread = {
    turns: [earlier, turn],
    tokenUsage: {
      last: { totalTokens: 123456 },
      total: { totalTokens: 800000 },
      modelContextWindow: 200000,
    },
  };
  const result = delegationResults(
    thread,
    turn,
    {},
    { terminals: [], jobs: [] },
    false,
    "claude",
  );
  assert.deepEqual(result.context, {
    usedTokens: 123456,
    totalTokens: 200000,
    compactCount: 2,
  });
  assert.deepEqual(
    delegationResults(
      thread,
      earlier,
      {},
      { terminals: [], jobs: [] },
      false,
      "claude",
    ).context,
    { compactCount: 1 },
  );
});

test("补问接受同一会话的短任务 ID 并保留原任务", () => {
  const data = { tasks: {}, notices: {}, receipts: {} };
  const assignment = {
    parent: { id: "owner", sourceName: "Codex", sourceRuntime: "runtime" },
    turn: { id: "parent-turn" },
    target: "codex",
    snapshot: { model: "fixture" },
    input: { request: "首次任务", request_id: "initial" },
  };
  const { task_id: id } = acceptDelegation(data, assignment);
  const follow = {
    ...assignment,
    snapshot: null,
    input: { request: "补充任务", request_id: "follow", task_id: traceId(id) },
  };
  assert.throws(
    () =>
      acceptDelegation(data, {
        ...follow,
        parent: { ...assignment.parent, sourceRuntime: "other" },
      }),
    /无法继续/,
  );
  assert.equal(acceptDelegation(data, follow).task_id, id);
  assert.equal(acceptDelegation(data, follow).task_id, id);
  assert.deepEqual(Object.keys(data.tasks), [id]);
  assert.equal(data.tasks[id].steps.length, 2);
});

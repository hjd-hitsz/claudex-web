import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAcpSessions } from "../src/backends/agy/acp-session.mjs";
import { createAgyStore } from "../src/backends/agy/session-store.mjs";
import { readArchivedToolOutput } from "../src/backends/agy/archived-tool-output.mjs";
import {
  findAgyToolResults,
  restoreAgyToolResults,
} from "../src/backends/agy/tmp_function/history-tool-results.mjs";
import {
  agyHistoryPrompt,
  agyHistoryRecords,
  assertAgyHistoryIdle,
  createAgyHistoryActions,
  retainedAgyTurns,
} from "../src/backends/agy/tmp_function/session-history.mjs";

const turn = (id, items = []) => ({ id, status: "completed", items });
const user = (text) => ({
  id: text,
  type: "userMessage",
  content: [{ type: "text", text }],
});
const first = turn("first", [
  user("保留用户输入"),
  { type: "agentMessage", text: "保留助手回复" },
  {
    type: "mcpToolCall",
    status: "completed",
    tool: "read_file",
    arguments: { path: "marker" },
    result: "已读取标记",
  },
  { type: "mcpToolCall", status: "inProgress", tool: "仍在运行" },
  { ...user("内部回投正文"), origin: "delegation" },
  { type: "reasoning", summary: ["内部推理"] },
]);
const second = turn("second", [user("分叉边界，编辑时排除")]);
const third = turn("third", [user("边界之后的消息")]);
const session = {
  id: "thread",
  nativeId: "original",
  model: "gemini",
  effort: "high",
  turns: [first, second, third],
};

test("保留分叉轮次与编辑前缀，重放记录将工具调用编码成文本", () => {
  assert.deepEqual(retainedAgyTurns(session.turns, second.id, true), [
    first,
    second,
  ]);
  assert.deepEqual(retainedAgyTurns(session.turns, second.id, false), [first]);
  assert.deepEqual(retainedAgyTurns(session.turns, first.id, false), []);
  assert.throws(
    () => retainedAgyTurns(session.turns, "unknown", true),
    /找不到/,
  );
  const block = agyHistoryPrompt({
    ...session,
    historyReplay: { nativeId: session.nativeId, throughTurnId: second.id },
  });
  assert.equal(block.type, "text");
  for (const text of [
    "保留用户输入",
    "保留助手回复",
    "read_file",
    "已读取标记",
    "分叉边界",
  ])
    assert(block.text.includes(text));
  for (const text of ["仍在运行", "内部回投正文", "内部推理", "边界之后的消息"])
    assert(!block.text.includes(text));
  assert.equal(
    agyHistoryPrompt({
      ...session,
      historyReplay: { nativeId: "old", throughTurnId: first.id },
    }),
    undefined,
  );
});

test("历史重放缩短工具输出并去重回投，仍可按调用 ID 读取原文", async () => {
  const output = "长工具输出🧪\n".repeat(1000);
  const item = {
    id: "call-large",
    type: "mcpToolCall",
    status: "completed",
    tool: "Read",
    result: output,
  };
  const result = {
    type: "delegationResult",
    taskId: "same-task",
    stepId: "step-one",
    status: "completed",
  };
  const sessions = {
    main: {
      id: "main",
      turns: [
        turn("first", [item, result]),
        turn("second", [result, { ...result, stepId: "step-two" }]),
      ],
    },
    other: { id: "other", turns: [] },
  };
  const saved = JSON.stringify(sessions);
  const records = agyHistoryRecords(sessions.main.turns).flat();
  assert.equal(records[0].archivedCallId, item.id);
  assert.ok(records[0].result.length <= 257);
  assert.deepEqual(
    records.slice(1).map(({ stepId }) => stepId),
    ["step-one", "step-two"],
  );

  const store = {
    read: async () => ({ sessions }),
    session: (data, id) => data.sessions[id],
  };
  const read = (offset) =>
    readArchivedToolOutput(store, "main", { callId: item.id, offset });
  let page = await read();
  let json = page.chunk;
  while (page.nextOffset !== null) {
    assert.ok(page.chunk.isWellFormed());
    page = await read(page.nextOffset);
    json += page.chunk;
  }
  assert.deepEqual(JSON.parse(json), {
    callId: item.id,
    tool: "Read",
    source: "saved",
    output,
  });
  await assert.rejects(
    readArchivedToolOutput(store, "other", { callId: item.id }),
    /找不到该已存档工具调用/,
  );
  assert.equal(JSON.stringify(sessions), saved);
});

test("已归档的 agy SQLite 保留工具全文，历史卡片引用原生调用", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agy-archived-tool-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(
    directory,
    ".gemini",
    "antigravity-cli",
    ".claudex-history",
    "archived",
  );
  await mkdir(archive, { recursive: true });
  const nativeId = "dec00ded-0000-4000-8000-000000000001";
  const callId = "fixture-call";
  const payload = "原始存档内容🧪".repeat(800);
  const numberBytes = (number) => {
    const bytes = [];
    while (number >= 128) {
      bytes.push((number % 128) + 128);
      number = Math.floor(number / 128);
    }
    return Buffer.from([...bytes, number]);
  };
  const field = (id, value) => {
    const bytes = Buffer.from(value);
    return Buffer.concat([
      numberBytes(id * 8 + 2),
      numberBytes(bytes.length),
      bytes,
    ]);
  };
  const db = new DatabaseSync(join(archive, nativeId + ".db"));
  try {
    db.exec(
      "CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_format INTEGER, metadata BLOB, step_payload BLOB)",
    );
    db.prepare("INSERT INTO steps VALUES (1, 132, 3, 0, ?, ?)").run(
      field(4, Buffer.concat([field(1, callId), field(2, "Read")])),
      field(140, field(2, field(1, payload))),
    );
  } finally {
    db.close();
  }
  const agentInfo = { name: "Antigravity ACP Server", version: "1.5.18" };
  const item = { id: callId, type: "mcpToolCall", status: "completed" };
  restoreAgyToolResults(
    [turn("archived", [item])],
    [nativeId],
    agentInfo,
    directory,
  );
  assert.equal(item.resultArchive, nativeId);
  assert.ok(item.result.content[0].text.length <= 4001);
  const found = findAgyToolResults([callId], [nativeId], agentInfo, {
    home: directory,
  });
  assert.deepEqual(found.get(callId), {
    nativeId,
    tool: "Read",
    text: payload,
  });
});

test("改写拒绝轮次、排队、整理、委派与待投递结果占用", () => {
  const idle = { tasks: {}, notices: {} };
  for (const [state, message] of [
    [{ active: true }, /轮次结束/],
    [{ pending: true }, /排队输入/],
    [{ compacting: true }, /整理上下文/],
    [{ delivering: true }, /结果回投/],
  ])
    assert.throws(() => assertAgyHistoryIdle(idle, session, state), message);
  const task = {
    id: "task",
    parentId: session.id,
    status: "running",
    steps: [{ id: "step" }],
  };
  const data = { tasks: { task }, notices: {} };
  assert.throws(() => assertAgyHistoryIdle(data, session, {}), /委派任务/);
  task.status = "completed";
  for (const status of ["queued", "submitting"]) {
    data.notices.result = {
      id: "step:result",
      taskId: task.id,
      parentId: session.id,
      kind: "result",
      status,
    };
    assert.throws(() => assertAgyHistoryIdle(data, session, {}), /结果回投/);
  }
  data.notices.result.status = "delivered";
  assert.doesNotThrow(() => assertAgyHistoryIdle(data, session, {}));
});

test("新原生会话准备成功才原子保存历史与映射，失败保留旧记录", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agy-history-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createAgyStore(directory);
  await store.change((data) => {
    data.sessions[session.id] = session;
  });
  const rewriting = new Set();
  let preparation = Promise.withResolvers();
  let entered = Promise.withResolvers();
  const discarded = [];
  const changes = [];
  const rewrite = createAgyHistoryActions({
    store,
    rewriting,
    occupancy: () => ({}),
    prepare(candidate) {
      assert.equal(candidate.nativeId, undefined);
      entered.resolve();
      return preparation.promise;
    },
    discard: (id) => discarded.push(id),
    changed: (saved) => changes.push(saved),
    wake() {},
  });
  const params = {
    beforeTurnId: second.id,
    beforeItemId: second.items[0].id,
    expectedLastTurnId: third.id,
  };
  const failed = rewrite("thread/revert", session.id, params);
  await entered.promise;
  assert.equal(rewriting.has(session.id), true);
  assert.deepEqual((await store.read()).sessions[session.id], session);
  await assert.rejects(rewrite("thread/fork", session.id, {}), /正在更新/);
  preparation.reject(new Error("原生准备失败"));
  await assert.rejects(failed, /原生准备失败/);
  assert.deepEqual((await store.read()).sessions[session.id], session);
  assert.deepEqual(discarded, [session.id, session.id]);
  assert.deepEqual(changes, []);

  preparation = Promise.withResolvers();
  entered = Promise.withResolvers();
  const committed = rewrite("thread/revert", session.id, params);
  await entered.promise;
  assert.deepEqual((await store.read()).sessions[session.id], session);
  preparation.resolve({
    nativeId: "replacement",
    config: { model: "gemini", effort: "high" },
  });
  const saved = await committed;
  assert.equal(saved.id, session.id);
  assert.equal(saved.previousNativeId, "original");
  assert.equal(saved.nativeId, "replacement");
  assert.deepEqual(saved.turns, [first]);
  assert.deepEqual(saved.historyReplay, {
    nativeId: "replacement",
    throughTurnId: first.id,
  });
  assert.deepEqual((await store.read()).sessions[session.id], saved);
  assert.deepEqual(changes, [saved]);
  assert.equal(rewriting.size, 0);
});

test("切换原生映射后旧 ACP 客户端的通知与审批请求无法进入新轮次", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agy-history-events-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  const sessions = createAcpSessions({
    getBackend: () => ({ stateDir: directory }),
    execution: { acpRequest: () => "current permission" },
    emit: (event) => events.push(event),
    createClient(handlers) {
      const client = {
        ...handlers,
        call: async (method, params) =>
          method === "initialize"
            ? {
                protocolVersion: 1,
                agentCapabilities: {
                  loadSession: true,
                  sessionCapabilities: { resume: {}, close: {} },
                  _meta: { antigravity: { systemPrompt: { append: true } } },
                },
              }
            : { sessionId: params.sessionId || "catalogue" },
        close() {
          this.closed = true;
        },
      };
      return client;
    },
  });
  t.after(() => sessions.close());
  await sessions.connect("fixture");
  await sessions.catalogue();
  const old = await sessions.open({ ...session, cwd: directory });
  sessions.discard(session.id);
  const current = await sessions.open({
    ...session,
    cwd: directory,
    nativeId: "replacement",
  });
  const activity = {
    entry: current,
    submitted: true,
    turn: turn("new"),
    compaction: { update: () => false },
    controller: new AbortController(),
  };
  sessions.active.set(session.id, activity);
  const deliver = (entry, nativeId, text) =>
    entry.client.onUpdate("session/update", {
      sessionId: nativeId,
      update: { sessionUpdate: "agent_message_chunk", content: { text } },
    });
  assert.equal(old.client.closed, true);
  deliver(old, old.nativeId, "旧连接迟到输出");
  deliver(current, old.nativeId, "新连接中的旧会话输出");
  assert.throws(
    () =>
      old.client.onRequest("session/request_permission", {
        sessionId: old.nativeId,
      }),
    /没有已提交的轮次/,
  );
  assert.deepEqual(activity.turn.items, []);
  deliver(current, current.nativeId, "当前轮次输出");
  assert.equal(activity.turn.items[0].text, "当前轮次输出");
  assert.equal(
    events.filter(({ method }) => method === "item/agentMessage/delta").length,
    1,
  );
  assert.equal(
    current.client.onRequest("session/request_permission", {
      sessionId: current.nativeId,
    }),
    "current permission",
  );
});

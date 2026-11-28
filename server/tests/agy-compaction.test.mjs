import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgyCompactions } from "../src/backends/agy/compactions.mjs";
import {
  agyTokenUsage,
  countAgyCompactions,
} from "../src/backends/agy/context-usage.mjs";
import { readAgyCheckpoint } from "../src/backends/agy/tmp_function/compaction-checkpoint.mjs";
import { createAgyAdapter } from "../src/backends/agy/adapter.mjs";
import { createAgyStore } from "../src/backends/agy/session-store.mjs";
import {
  acceptDelegation,
  finishDelegation,
} from "../src/backends/delegation/delegation-store.mjs";

function fixture(manual, checkpoint) {
  const activity = {
    input: { compaction: manual },
    session: { id: "thread", tokenUsage: { modelContextWindow: 1048576 } },
    turn: { id: "turn", status: "completed", startedAt: 1, items: [] },
  };
  const events = [];
  const emit = (method, params) => events.push({ method, params });
  const { track } = createAgyCompactions(checkpoint);
  const tracker = track(activity, emit);
  tracker.prepare("native");
  return { tracker, activity, events, emit };
}

test("AG 仅累计已确认的网页压缩记录", () => {
  const turns = [
    {},
    ...["running", "completed", "failed", "interrupted", "unconfirmed"].map(
      (status) => ({ compaction: { status } }),
    ),
  ];
  assert.equal(countAgyCompactions([]), 0);
  assert.equal(countAgyCompactions(turns), 1);
});

test("手动整理保存新会话后完成并清除旧用量", () => {
  const { tracker, activity, events } = fixture(true, () => null);
  assert.equal(
    tracker.update({
      sessionUpdate: "compaction_summary_chunk",
      content: { type: "text", text: "私有整理摘要" },
    }),
    true,
  );
  assert.deepEqual(activity.turn.items, []);
  assert.equal(events[0].params.compaction.status, "running");
  activity.compactionApplied = true;
  assert.equal(tracker.finish().status, "completed");
  assert.equal(activity.turn.items[0].type, "contextCompaction");
  assert.deepEqual(agyTokenUsage(activity), {
    turnId: "turn",
    round: {},
    modelContextWindow: 1048576,
    awaitingMeasurement: true,
  });
  assert(!JSON.stringify(events).includes("私有整理摘要"));
});

test("手动整理失败或未确认时保留原会话上下文占用", () => {
  for (const [turnStatus, expected] of [
    ["failed", "failed"],
    ["interrupted", "interrupted"],
    ["completed", "unconfirmed"],
  ]) {
    const { tracker, activity } = fixture(true, () => 3);
    activity.session.tokenUsage.last = { totalTokens: 71 };
    activity.session.tokenUsage.round = { totalTokens: 71 };
    activity.turn.status = turnStatus;
    assert.equal(tracker.finish().status, expected);
    assert.deepEqual(activity.turn.items, []);
    assert.deepEqual(agyTokenUsage(activity), {
      turnId: "turn",
      round: {},
      last: { totalTokens: 71 },
      modelContextWindow: 1048576,
    });
  }
});

test("自动整理只按新检查点或结构化状态确认，使用原生用量", () => {
  let latest = 4;
  const { tracker, activity } = fixture(false, () => latest);
  assert.equal(tracker.update({ sessionUpdate: "compaction" }), false);
  assert.equal(tracker.finish(), undefined);
  latest = 5;
  activity.usage = { used: 82, size: 1048576 };
  activity.promptUsage = {
    inputTokens: 114,
    cachedReadTokens: 20,
    outputTokens: 16,
    thoughtTokens: 5,
    totalTokens: 155,
  };
  assert.equal(tracker.finish().source, "automatic");
  assert.deepEqual(agyTokenUsage(activity), {
    turnId: "turn",
    round: {
      inputTokens: 114,
      cachedInputTokens: 20,
      outputTokens: 16,
      reasoningOutputTokens: 5,
      totalTokens: 155,
    },
    last: { totalTokens: 82 },
    modelContextWindow: 1048576,
  });
  const structured = fixture(false, () => null);
  const update = (status) =>
    structured.tracker.update({
      sessionUpdate: "compaction_update",
      compactionId: "acp-checkpoint",
      status,
    });
  assert.equal(update("in_progress"), true);
  assert.equal(structured.events[0].params.compaction.status, "running");
  assert.equal(update("failed"), true);
  assert.equal(structured.tracker.finish().status, "failed");
});

test("本轮只记录 ACP 提供的字段，包括显式的零", () => {
  const { activity } = fixture(false, () => null);
  activity.session.tokenUsage.round = { inputTokens: 30, totalTokens: 50 };
  activity.contextChanged = true;
  activity.promptUsage = {
    inputTokens: 0,
    cachedReadTokens: null,
    outputTokens: 8,
    thoughtTokens: -1,
  };
  assert.deepEqual(agyTokenUsage(activity), {
    turnId: "turn",
    round: { inputTokens: 0, outputTokens: 8 },
  });
});

test("读取版本匹配的原生已完成检查点，忽略普通和未完成步骤", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-checkpoint-"));
  const id = "7dd340b8-cc05-4a79-a4a1-e43c176b72cf";
  const agent = { name: "Antigravity ACP Server", version: "1.5.18" };
  try {
    await mkdir(join(directory, "conversations"));
    const db = new DatabaseSync(join(directory, "conversations", id + ".db"));
    try {
      db.exec(
        "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER); " +
          "INSERT INTO steps VALUES (3, 23, 3), (4, 15, 3), (5, 23, 2);",
      );
    } finally {
      db.close();
    }
    assert.equal(readAgyCheckpoint(id, agent, directory), 3);
    assert.equal(readAgyCheckpoint("../elsewhere", agent, directory), null);
    assert.equal(
      readAgyCheckpoint(id, { ...agent, version: "1.5.19" }, directory),
      3,
    );
    assert.equal(
      readAgyCheckpoint(id, { ...agent, version: "1.5.20" }, directory),
      null,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("agy 整理拒绝进行中的委派和未结算的当前结果回投", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agy-compact-delegation-"));
  const executable = join(directory, "agy");
  const cli = new URL(
    "../../tests/helpers/agy-fixture-cli.mjs",
    import.meta.url,
  );
  await writeFile(
    executable,
    `#!${process.execPath}\nimport(${JSON.stringify(cli.href)});\n`,
    { mode: 0o700 },
  );
  const store = createAgyStore(directory);
  const parent = {
    id: "secretary",
    cwd: directory,
    nativeId: "original-native",
    turns: [{ id: "turn", status: "completed", items: [] }],
  };
  const taskId = await store.change((data) => {
    data.sessions[parent.id] = parent;
    const { task_id: id } = acceptDelegation(data, {
      parent,
      turn: parent.turns[0],
      target: "codex",
      snapshot: {},
      input: { request: "核对隔离材料", request_id: "fixture" },
    });
    data.tasks[id].status = "running";
    return id;
  });
  const events = [];
  const adapter = createAgyAdapter({
    backend: { stateDir: directory, executable },
    config: { configDir: directory, upstreamUrl: "ws://127.0.0.1:8765" },
    emit: (event) => events.push(event),
  });
  t.after(async () => {
    adapter.close();
    await rm(directory, { recursive: true, force: true });
  });
  await adapter.connect();
  // 挂起执行端调度，以逐个核对 API 读取到的持久状态。
  adapter.execution.close();
  assert.equal((await adapter.state()).params.ready, true);
  const compact = () =>
    adapter.request("thread/compact/start", { threadId: parent.id });
  await assert.rejects(compact(), /请先等待或停止此对话的委派任务/);

  const noticeId = await store.change((data) => {
    finishDelegation(data, data.tasks[taskId], "completed", {
      answer: "已结算",
    });
    return Object.keys(data.notices)[0];
  });
  await assert.rejects(compact(), /请等待此对话的委派结果回投完成/);
  await store.change((data) => {
    data.notices[noticeId].status = "submitting";
  });
  await assert.rejects(compact(), /请等待此对话的委派结果回投完成/);
  assert.deepEqual((await store.read()).sessions[parent.id], parent);
  assert(!events.some(({ method }) => method === "lan/compaction"));
});

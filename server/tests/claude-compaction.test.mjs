import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAgentActivity } from "../src/backends/claude/agent-activity.mjs";
import { createSessionReader } from "../src/backends/claude/history.mjs";
import { createClaudeSessions } from "../src/backends/claude/sessions.mjs";

test("Claude 压缩整理历史沿原生轮次恢复，隐藏未登记的整理代理完成记录", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "claude-compact-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  const dataDir = join(root, "claude");
  const project = join(dataDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await Promise.all(
    [cwd, project].map((dir) => mkdir(dir, { recursive: true })),
  );
  const sessionId = randomUUID();
  const entries = [];
  let parentUuid = null;
  function append(type, fields) {
    const uuid = fields.uuid ?? randomUUID();
    entries.push({
      type,
      uuid,
      parentUuid,
      sessionId,
      cwd,
      timestamp: new Date(1700000000000 + entries.length * 1000).toISOString(),
      entrypoint: "sdk-ts",
      isSidechain: false,
      ...fields,
    });
    parentUuid = uuid;
    return uuid;
  }
  const user = (content, fields) =>
    append("user", { message: { role: "user", content }, ...fields });
  const prompt = (text) =>
    user(text, { promptId: randomUUID(), promptSource: "sdk" });
  const assistant = (content, stop_reason = "end_turn") =>
    append("assistant", {
      message: { role: "assistant", id: randomUUID(), content, stop_reason },
    });
  const text = (value) => [{ type: "text", text: value }];
  const first = prompt("第一轮");
  const before = assistant(text("第一轮答复"));
  const summary = randomUUID();
  const manual = append("system", {
    subtype: "compact_boundary",
    parentUuid: null,
    logicalParentUuid: before,
    compactMetadata: {
      trigger: "manual",
      preservedSegment: {
        headUuid: before,
        tailUuid: before,
        anchorUuid: summary,
      },
    },
  });
  user("仅用于续接的压缩摘要", {
    uuid: summary,
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  });
  user("<local-command-caveat>本地命令记录</local-command-caveat>", {
    isMeta: true,
  });
  const command = user(
    "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>保留项目路径</command-args>",
    { promptId: randomUUID() },
  );
  user("<local-command-stdout>Compacted</local-command-stdout>", {
    promptId: entries.at(-1).promptId,
  });
  const followup = prompt("第二轮");
  const tool = "toolu_fixture_read";
  assistant(
    [
      { type: "thinking", thinking: "读取隔离记录" },
      {
        type: "tool_use",
        name: "Read",
        id: tool,
        input: { file_path: "proof.txt" },
      },
    ],
    "tool_use",
  );
  const result = user([
    { type: "tool_result", tool_use_id: tool, content: "读取完成" },
  ]);
  const automatic = append("system", {
    subtype: "compact_boundary",
    parentUuid: null,
    logicalParentUuid: result,
    compactMetadata: { trigger: "auto" },
  });
  user("自动整理摘要", {
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  });
  assistant(text("第二轮答复"));
  const next = prompt("第三轮");
  assistant(text("第三轮答复"));
  await writeFile(
    join(project, sessionId + ".jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const ghost = "agent/" + sessionId + "/ephemeral-summary";
  const onlyInIndex = {
    id: "web-only",
    startedAt: 1700000000.5,
    status: "completed",
    items: [
      {
        id: "web-item",
        type: "agentMessage",
        phase: "final_answer",
        text: "网页已保存的答复",
      },
    ],
  };
  const session = {
    id: sessionId,
    cwd,
    initialized: true,
    turns: { [onlyInIndex.id]: onlyInIndex },
    agents: {
      [ghost]: { agentId: "ephemeral-summary", name: "claudex-secretary" },
    },
    extraItems: {
      ghost: {
        id: "ghost",
        turnId: command,
        agentThreadId: ghost,
        type: "subAgentActivity",
        kind: "completed",
      },
    },
  };
  const readSession = createSessionReader({ dataDir });
  const calls = [];
  const sessions = createClaudeSessions({
    config: {},
    storage: { read: async () => ({ sessions: { [sessionId]: session } }) },
    readSession: (...args) => {
      calls.push(args[0]);
      return readSession(...args);
    },
    runtime: { running: new Map() },
  });
  t.after(sessions.close);
  const records = await sessions.turns(sessionId);
  assert.deepEqual(
    records.map(({ id }) => id),
    [first, "web-only", command, followup, next],
  );
  assert.deepEqual(
    records.flatMap(({ items }) =>
      items
        .filter(({ phase }) => phase === "final_answer")
        .map(({ text }) => text),
    ),
    ["第一轮答复", "网页已保存的答复", "第二轮答复", "第三轮答复"],
  );
  assert.deepEqual(
    records[2].items.map(({ type }) => type),
    ["userMessage", "contextCompaction"],
  );
  assert.deepEqual(records[2].items[0].content, text("/compact 保留项目路径"));
  assert.equal(records[2].items[1].id, manual);
  assert.deepEqual(
    records[3].items.map(({ type }) => type),
    [
      "userMessage",
      "reasoning",
      "dynamicToolCall",
      "contextCompaction",
      "agentMessage",
    ],
  );
  assert.equal(records[3].items[2].contentItems[0].text, "读取完成");
  assert.equal(records[3].items[3].id, automatic);
  assert(!calls.includes("getSubagentMessages"));
  const params = { threadId: sessionId, sortDirection: "desc", limit: 2 };
  const latest = await sessions.request("thread/turns/list", params);
  const previous = await sessions.request("thread/turns/list", {
    ...params,
    cursor: latest.nextCursor,
  });
  assert.deepEqual(
    latest.data.map(({ id }) => id),
    [next, followup],
  );
  assert.deepEqual(
    previous.data.map(({ id }) => id),
    [command, "web-only"],
  );
});

test("Claude 子代理完成事件保留启动轮次，整理期间的单独 Stop 无详情入口", async () => {
  let session = {
    agentCalls: {
      tool: { toolUseId: "tool", turnId: "original", name: "真实子代理" },
    },
  };
  const events = [];
  const record = createClaudeAgentActivity(
    async (_id, update) => {
      session = update(session);
    },
    (method, params) => events.push({ method, ...params }),
  );
  const parentNativeId = "native";
  await record("thread", {
    parentNativeId,
    agentId: "summary",
    agentType: "claudex-secretary",
    turnId: "compact",
    kind: "completed",
  });
  assert.equal(events.length, 0);
  assert.deepEqual(Object.keys(session.agents || {}), []);
  await record("thread", {
    parentNativeId,
    agentId: "child",
    agentType: "claudex-secretary",
    turnId: "original",
    kind: "started",
  });
  await record("thread", {
    parentNativeId,
    agentId: "child",
    turnId: "compact",
    toolUseId: "tool",
    kind: "started",
  });
  await record("thread", {
    parentNativeId,
    agentId: "child",
    turnId: "next",
    kind: "completed",
  });
  assert.equal(session.agents["agent/thread/child"].toolUseId, "tool");
  assert.deepEqual(
    events.map(({ turnId, item }) => [turnId, item.kind]),
    [
      ["original", "started"],
      ["original", "started"],
      ["original", "completed"],
    ],
  );
});

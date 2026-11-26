import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { readRolloutTools } from "../src/backends/codex/rollout-tools.mjs";
import { artifactTree } from "../src/backends/delegation/artifact-tree.mjs";
import { turnCalls } from "../src/backends/delegation/call-chain.mjs";
import { readDelegationStep } from "../src/backends/delegation/step-details.mjs";

test("目录树压缩多层前缀并逐字恢复每个路径和变更类型", () => {
  const paths = [
    "/work/project/a/file-1",
    "/work/project/a/file-2",
    "/work/project/b/文件\t名",
    "/work/project/b/文件\t名",
    "/work/project/b/root",
    "/work/project/b/root/child",
    "relative//file",
    "relative/./nested/file",
    "relative/../file",
    "__proto__/file",
    "relative/" + "🧪".repeat(1300),
    ...Array.from({ length: 150 }, (_, index) => "/work/project/a/" + index),
  ];
  const records = paths.map((path, index) => ({
    path,
    kind: { type: index % 2 ? "add" : "delete" },
  }));
  const tree = artifactTree(records);
  const unpack = (entries, parent) =>
    entries.flatMap(([segment, kinds, children = []]) => {
      const path = parent === undefined ? segment : parent + "/" + segment;
      return [
        ...kinds.map((kind) => ({ path, kind })),
        ...unpack(children, path),
      ];
    });
  assert.deepEqual(unpack(tree).toSorted(compare), records.toSorted(compare));
  function compare(a, b) {
    return a.path.localeCompare(b.path);
  }
  assert.equal(tree[0][0], "/work/project");
  assert(
    Buffer.byteLength(JSON.stringify(tree)) <
      Buffer.byteLength(JSON.stringify(records)),
  );
});

test("Codex 原生调用按 Rollout 顺序回投，可按步骤读取原始输入输出", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "claudex-delegation-trace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "rollout.jsonl");
  const thread = {
    id: "native",
    path,
    turns: [
      {
        id: "first",
        items: [
          {
            type: "commandExecution",
            id: "shell",
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
      call_id: "shell",
      arguments: '{"cmd":"printf done","max_output_tokens":26}',
    }),
    response({ type: "function_call_output", call_id: "shell", output: full }),
    response({
      type: "custom_tool_call",
      name: "apply_patch",
      call_id: "patch",
      input: "full patch text",
    }),
    response({
      type: "custom_tool_call_output",
      call_id: "patch",
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
      call_id: "shell",
      arguments: '{"cmd":"printf other"}',
    }),
    response({
      type: "function_call_output",
      call_id: "shell",
      output: "other step output",
    }),
  ];
  await writeFile(
    path + ".zst",
    zstdCompressSync(raw.map((record) => JSON.stringify(record)).join("\n")),
  );
  const rollout = await readRolloutTools(thread, new Set(["first"]));
  const chain = turnCalls(thread.turns[0], rollout.get("first"), "codex");
  assert.deepEqual(
    chain.map(({ callId, tool }) => [callId, tool]),
    [
      ["shell", "exec_command"],
      ["patch", "apply_patch"],
    ],
  );

  const task = {
    id: "task",
    parentId: "owner",
    sourceRuntime: "original",
    target: "codex",
    executor: { threadId: "native" },
    steps: [
      { id: "step", turnId: "first", result: { callChain: chain } },
      { id: "follow", turnId: "followup" },
    ],
  };
  const store = { read: async () => ({ tasks: { task } }) };
  let reads = 0;
  const executor = {
    resolve: async () => ({}),
    readHistory: async () => {
      reads++;
      return { thread };
    },
  };
  const owner = { id: "owner", runtimeId: "original" };
  const input = { taskId: "task", stepId: "step" };
  const read = (args, parent = owner) =>
    readDelegationStep(store, executor, parent, { ...input, ...args });
  await assert.rejects(read({}, { ...owner, id: "other" }), /找不到该委派任务/);
  await assert.rejects(
    read({}, { ...owner, runtimeId: "replacement" }),
    /找不到该委派任务/,
  );
  await assert.rejects(read({ stepId: "missing" }), /找不到该步骤/);
  assert.deepEqual((await read({})).result.callChain, chain);
  assert.equal(reads, 0);
  await assert.rejects(read({ callId: "another" }), /找不到指定调用/);
  await assert.rejects(
    read({ callId: "shell", turnId: "followup" }),
    /找不到指定调用/,
  );
  assert.equal(
    (await read({ callId: "patch" })).raw.outputs[0].payload.output,
    "patch complete",
  );

  let page = await read({ callId: "shell" });
  let text = page.chunk;
  while (page.nextOffset !== null) {
    assert(page.chunk.isWellFormed());
    page = await read({ callId: "shell", offset: page.nextOffset });
    text += page.chunk;
  }
  const detail = JSON.parse(text);
  assert.deepEqual(detail.raw.input, raw[2]);
  assert.deepEqual(detail.raw.outputs, [raw[3]]);
  assert.equal(detail.item.command, "printf done");
  const follow = await read({ callId: "shell", stepId: "follow" });
  assert.equal(follow.raw.outputs[0].payload.output, "other step output");
  assert.equal(
    (await readRolloutTools({ ...thread, id: "wrong" }, new Set(["first"])))
      .size,
    0,
  );
});

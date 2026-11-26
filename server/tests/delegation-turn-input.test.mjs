import assert from "node:assert/strict";
import test from "node:test";
import { delegationTurnParams } from "../src/backends/delegation/executors.mjs";

test("秘书的旧委派记录只向执行端发送整理好的任务，原生委派保留原输入", () => {
  const original = [
    { type: "text", text: "你负责写报告。PRIVATE_SECRETARY_FIXTURE" },
    { type: "image", url: "data:image/png;base64,AA==" },
  ];
  for (const target of ["codex", "claude"]) {
    for (const input of [{ original }, { stepOriginal: original }]) {
      const task = {
        target,
        scope: "research",
        selection: {},
        executor: { threadId: "executor-fixture" },
        original: input.original,
        steps: [
          {
            id: "step-fixture",
            request: "核对解析函数处理空文件的行为。",
            original: input.stepOriginal,
          },
        ],
      };
      const secretary = delegationTurnParams(task);
      assert.equal(secretary.input.length, 2);
      assert.match(secretary.input[0].text, /专家/);
      assert.match(secretary.input[1].text, /核对解析函数处理空文件/);
      const native = delegationTurnParams({ ...task, sourceName: "Codex" });
      assert.deepEqual(native.input.slice(1, -1), original);
    }
  }
});

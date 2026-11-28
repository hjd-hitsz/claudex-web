import assert from "node:assert/strict";
import test from "node:test";
import { delegationNotice } from "../src/backends/agy/delegation-delivery.mjs";
import { noticeResult } from "../src/backends/delegation/call-chain.mjs";
import {
  delegationResults,
  saveDelegationResults,
} from "../src/backends/delegation/delegation-results.mjs";
import { delegationSummaries } from "../src/backends/delegation/delivery-summary.mjs";
import {
  delegationResultItem,
  formatConversationMessage,
  matchesConversationMessage,
} from "../src/conversation-manager/message.mjs";

const taskId = "ad14c2bd";
const stepId = "08e4c0d2";
const final = (text) => ({ type: "agentMessage", phase: "final_answer", text });
const turn = (id, items, attributes) => ({
  id,
  items,
  status: "completed",
  ...attributes,
});
const completed = (ids) =>
  backgroundNotice(
    "background_completed",
    ids.map((job_id) => ({ job_id, title: "构建检查" })),
  );
const backgroundNotice = (name, results) => ({
  type: "functionCallOutput",
  name,
  output: JSON.stringify({ results }),
});

function settle(target, turns, { jobs = [], tasks = {}, stopRequested } = {}) {
  const step = { id: stepId, acceptedAt: 10, stopRequested };
  const task = { id: taskId, target, steps: [step] };
  const data = { notices: {} };
  const results = delegationResults(
    { turns, backgroundTasks: tasks },
    turns[0],
    step,
    { jobs, terminals: [] },
    false,
    target,
  );
  assert.equal(results.pending, false);
  saveDelegationResults(data, task, results);
  const notice = data.notices[stepId + ":result"];
  const [{ text }] = delegationNotice(notice, task).prompt;
  assert.deepEqual(JSON.parse(text.split("\n").at(-1)), {
    taskId,
    ...notice.payload,
  });
  const envelope = {
    id: stepId,
    from: { title: target === "codex" ? "Codex" : "Claude Code" },
    delegation: true,
    body: JSON.stringify({ task_id: taskId, ...noticeResult(notice, task) }),
  };
  const message = formatConversationMessage(envelope);
  assert(matchesConversationMessage(message, envelope));
  assert.equal(
    delegationResultItem({}, message).preview,
    delegationSummaries(task.steps)[stepId].preview,
  );
  return { result: step.result, payload: notice.payload };
}

test("Codex 保留派单与较短的完成答复，排除旧步骤批次和独立用户轮", () => {
  const first = "已核对生产构建及全部资源，准备交付。";
  const follow = "后台检查通过。";
  const { result, payload } = settle(
    "codex",
    [
      turn("dispatch", [
        { type: "userMessage" },
        { type: "userMessage", id: "same-turn-addendum" },
        final(first),
      ]),
      turn("prior-batch", [completed(["old-a", "old-b"]), final("旧步骤结果")]),
      turn("completion", [completed(["current"]), final(follow)]),
      turn("manual", [{ type: "userMessage" }, final("独立用户轮")]),
      turn("later", [completed(["current"]), final("用户轮之后")]),
    ],
    {
      jobs: [
        { id: "old-a", startedAt: 1 },
        { id: "old-b", startedAt: 2 },
        { id: "current", startedAt: 11 },
      ],
    },
  );
  assert.deepEqual(
    result.turns.map(({ turnId }) => turnId),
    ["dispatch", "completion"],
  );
  assert.equal(result.conclusion, follow);
  assert.equal(
    payload.answer,
    `## 派单轮答复\n\n${first}\n\n## 后台终端完成 · 构建检查（ID current）\n\n${follow}`,
  );
  assert.equal(payload.preview, first);
});

test("Codex 多触发续跑在完整过程与固化回投中共用计数标题和有序明细", () => {
  const first = "派单已查阅配置。";
  const check = (...ids) =>
    backgroundNotice(
      "background_check_due",
      ids.map((job_id) => ({ job_id, title: "进度检查" })),
    );
  const { result, payload } = settle("codex", [
    turn("dispatch", [final(first)]),
    turn("complete", [
      completed(["third", "first", "second"]),
      final("构建通过。"),
    ]),
    turn("mixed", [
      check("progress"),
      completed(["build"]),
      final("补充两项进展。"),
    ]),
    turn("checks", [check("watch-b", "watch-a"), final("两项仍在运行。")]),
    turn("check", [check("single"), final("继续等待。")]),
    turn("native", [final("原生续跑结束。")], { automatic: true }),
  ]);
  const followUps = [
    "## 后台终端完成 · 3 项\n\n- 构建检查（ID third）\n- 构建检查（ID first）\n- 构建检查（ID second）\n\n构建通过。",
    "## 后台终端 · 2 项\n\n- 软检查 · 进度检查（ID progress）\n- 完成 · 构建检查（ID build）\n\n补充两项进展。",
    "## 后台终端软检查 · 2 项\n\n- 进度检查（ID watch-b）\n- 进度检查（ID watch-a）\n\n两项仍在运行。",
    "## 后台终端软检查 · 进度检查（ID single）\n\n继续等待。",
    "## 原生续跑 · 第 6 轮\n\n原生续跑结束。",
  ].join("\n\n");
  assert.equal(result.answer, `## 当前委派\n\n${first}\n\n${followUps}`);
  assert.equal(payload.answer, `## 派单轮答复\n\n${first}\n\n${followUps}`);
  assert.equal(result.conclusion, "原生续跑结束。");
  assert.equal(payload.preview, first);
});

test("Claude 多触发明细使用缺省标题并保留运行 ID，任务名按纯文本显示", () => {
  const { result, payload } = settle(
    "claude",
    [
      turn("dispatch", [final("已派单。")]),
      turn("follow-up", [final("两项已完成。")], {
        backgroundTriggers: [
          { id: "shell-a", runId: "run-a" },
          { id: "shell-b", runId: "run-b" },
        ],
      }),
    ],
    { tasks: { "shell-b": { description: "复核 [文件]\n**$结果$**" } } },
  );
  const section =
    "## 后台终端完成 · 2 项\n\n- 终端（ID shell-a，运行 ID run-a）\n- 复核 &#91;文件&#93; &#42;&#42;&#36;结果&#36;&#42;&#42;（ID shell-b，运行 ID run-b）\n\n两项已完成。";
  assert.equal(result.answer, `## 当前委派\n\n已派单。\n\n${section}`);
  assert.equal(payload.answer, `## 派单轮答复\n\n已派单。\n\n${section}`);
});

test("Claude 使用任务和运行 ID 归属续跑，唯一可用答复保留原文", () => {
  const answer = "  阶段完成。\n\n复核通过。\n";
  const { result, payload } = settle(
    "claude",
    [
      turn("dispatch", []),
      turn("native", [final(answer)], {
        automatic: true,
        backgroundTriggers: [{ id: "shell-1", runId: "run-1" }],
      }),
    ],
    {
      tasks: {
        "shell-1": {
          task_id: "shell-1",
          run_id: "run-1",
          description: "原生检查",
          startedAt: 12,
          status: "completed",
        },
      },
    },
  );
  assert.deepEqual(result.turns[1].triggers, [
    {
      id: "shell-1",
      runId: "run-1",
      title: "原生检查",
      kind: "completion",
      status: "completed",
    },
  ]);
  assert.equal(payload.status, "completed");
  assert.equal(payload.answer, answer);
  assert.equal(payload.preview, "阶段完成。 复核通过。");
});

test("末轮无答复时交付派单原文，历史记录使用原有结论或已有文字", () => {
  const { result, payload } = settle("claude", [
    turn("dispatch", [final("已按要求核对。")]),
    turn("empty", [final("  \n")], { automatic: true }),
  ]);
  assert.equal(payload.answer, "已按要求核对。");
  assert.equal(result.conclusion, "");
  const notice = {
    id: stepId + ":result",
    payload: { status: "completed", answer: "旧投递摘要" },
  };
  const legacy = (result) =>
    noticeResult(notice, { steps: [{ id: stepId, result }] });
  assert.equal(
    legacy({ conclusion: "旧结论", answer: "旧完整正文" }).answer,
    "旧结论",
  );
  assert.equal(
    legacy({ conclusion: "", answer: "旧完整正文" }).answer,
    "旧完整正文",
  );
  assert.deepEqual(legacy({ conclusion: "", answer: " " }), {
    stepId,
    status: "completed",
  });
});

test("无答复时两条投递路径保留终态和原生错误", () => {
  for (const [nativeStatus, stopRequested, status] of [
    ["failed", false, "failed"],
    ["interrupted", false, "interrupted"],
    ["interrupted", true, "stopped_by_user"],
  ]) {
    const error = "原生执行错误";
    const { result, payload } = settle(
      "codex",
      [
        turn("dispatch", [], {
          status: nativeStatus,
          error: { message: error },
        }),
      ],
      { stopRequested },
    );
    assert.deepEqual(payload, {
      stepId,
      status,
      error,
      context: { compactCount: 0 },
    });
    assert.equal(result.deliveryAnswer, null);
    assert.equal(result.turns[0].status, nativeStatus);
  }
});

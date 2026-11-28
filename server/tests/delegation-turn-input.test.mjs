import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexSecretaryTurn } from "../src/backends/codex/secretary-mode.mjs";
import { codexConversationToolParams } from "../src/backends/codex/conversation-tools.mjs";
import { createDelegationModes } from "../src/backends/delegation/source-modes.mjs";
import { delegationTurnParams } from "../src/backends/delegation/executors.mjs";
import { acceptDelegation } from "../src/backends/delegation/delegation-store.mjs";
import { conversationArguments } from "../src/conversation-manager/tools.mjs";

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

test("原生委派通过请求与调用回执去重，模型参数不携带宿主身份", () => {
  const data = { tasks: {}, receipts: {}, notices: {} };
  const input = conversationArguments("delegate_task", {
    request: "检查工作区的构建结果",
    request_id: "build-check",
  });
  assert.throws(
    () =>
      conversationArguments("delegate_task", { ...input, token: "fixture" }),
    /token 无效/,
  );
  assert.throws(
    () =>
      conversationArguments("delegate_task", { ...input, threadId: "other" }),
    /threadId 无效/,
  );
  const args = {
    parent: {
      id: "owner",
      cwd: "/work",
      sourceName: "Codex",
      sourceRuntime: "runtime",
    },
    turn: { id: "turn" },
    callId: "native-call",
    target: "claude",
    snapshot: { model: "fixture" },
    input,
  };
  const result = acceptDelegation(data, args);
  assert.deepEqual(acceptDelegation(data, args), result);
  assert.deepEqual(
    acceptDelegation(data, { ...args, callId: "retry-call" }),
    result,
  );
  assert.throws(
    () =>
      acceptDelegation(data, {
        ...args,
        input: { ...input, request_id: "changed" },
      }),
    /委派失败.*请求 ID/,
  );
  assert.equal(Object.keys(data.tasks).length, 1);
  assert.equal(data.tasks[result.task_id].steps.length, 1);
});

test("委派模式默认关闭，按后端实例和对话保存", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "claudex-source-mode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modes = createDelegationModes(root);
  const backend = { id: "codex", type: "codex", dataDir: "/fixture/one" };
  assert.equal(await modes.enabled(backend, "shared"), false);
  await modes.save(backend, "shared", true);
  const reopened = createDelegationModes(root);
  assert.equal(await reopened.enabled(backend, "shared"), true);
  assert.equal(await reopened.enabled(backend, "other"), false);
  assert.equal(
    await reopened.enabled({ ...backend, dataDir: "/fixture/two" }, "shared"),
    false,
  );
  await reopened.save(backend, "shared", false);
  assert.equal(await modes.enabled(backend, "shared"), false);
});

test("Codex 条件开放派单，关闭时恢复原生协作指令", () => {
  const params = { model: "fixture", effort: "low" };
  const endpoint = { socketPath: "fixture" };
  const configKey = "mcp_servers.claudex_conversations";
  const ordinary = codexConversationToolParams(
    "thread/resume",
    params,
    endpoint,
  );
  assert.deepEqual(ordinary.config[configKey].disabled_tools, [
    "delegate_task",
  ]);
  assert.equal(codexSecretaryTurn(params, {}), params);
  const enabled = codexConversationToolParams(
    "thread/resume",
    params,
    endpoint,
    true,
  );
  assert.deepEqual(enabled.config[configKey].disabled_tools, []);
  const role = "完整角色正文".repeat(1000);
  const optedIn = codexSecretaryTurn(params, {}, role);
  assert(
    optedIn.collaborationMode.settings.developer_instructions.includes(role),
  );
  assert.equal(optedIn.additionalContext, undefined);
  assert.deepEqual(codexSecretaryTurn(params, optedIn).collaborationMode, {
    mode: "default",
    settings: {
      model: "fixture",
      reasoning_effort: "low",
      developer_instructions: null,
    },
  });
});

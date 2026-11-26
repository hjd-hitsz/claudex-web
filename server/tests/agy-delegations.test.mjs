import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptDelegation,
  currentResultNotice,
  finishDelegation,
  queueNotice,
} from "../src/backends/agy/delegation-store.mjs";
import { validateAgyBackend } from "../src/backends/agy/configuration.mjs";
import { acpFileChanges } from "../src/backends/agy/acp-files.mjs";
import { projectAgyQuota } from "../src/backends/agy/quota.mjs";
import { answerAcpPermission } from "../src/backends/agy/acp-permissions.mjs";
import { createDelegatedThreadIndex } from "../src/backends/agy/delegated-threads.mjs";
import { createAgyAdapter } from "../src/backends/agy/adapter.mjs";
import {
  delegationResults,
  saveDelegationResults,
} from "../src/backends/agy/delegation-results.mjs";
import { createDelegationExecution } from "../src/backends/agy/delegation-execution.mjs";

test("软检查及未结算的完成续跑保持沉默，最终结果标注两种触发", () => {
  const initial = {
    id: "first",
    status: "completed",
    items: [
      { type: "agentMessage", phase: "commentary", text: "工作过程" },
      { type: "agentMessage", phase: "final_answer", text: "已启动终端" },
    ],
  };
  const wake = (id, name, status) => ({
    id,
    status,
    items: [
      {
        type: "functionCallOutput",
        name,
        output: JSON.stringify({
          results: [{ job_id: "job", title: "项目检查", status: "completed" }],
        }),
      },
    ],
  });
  const check = wake("check", "background_check_due", "completed");
  const finished = wake("finish", "background_completed", "completed");
  const background = {
    terminals: [],
    jobs: [
      {
        id: "job",
        startedAt: 2,
        status: "completed",
        delivery: "accepted",
      },
    ],
  };
  const read = (...turns) =>
    delegationResults(
      { turns: [initial, ...turns] },
      initial,
      { acceptedAt: 1 },
      background,
      false,
      "codex",
    );
  const partial = read(check, { ...finished, status: "inProgress" });
  assert.equal(partial.pending, true);
  assert.equal(partial.stages[0].answer, "已启动终端");
  assert.equal(partial.stages[1].triggers[0].kind, "check");
  const data = { notices: {} };
  const task = {
    id: "task",
    parentId: "parent",
    status: "running",
    steps: [{ id: "step" }],
  };
  saveDelegationResults(data, task, partial);
  assert.deepEqual(data.notices, {});
  assert.equal(task.status, "running");
  const result = read(check, finished);
  assert.equal(result.pending, false);
  assert.equal(result.stages[2].triggers[0].kind, "completion");
  saveDelegationResults(data, task, result);
  const [notice] = Object.values(data.notices);
  assert.equal(notice.kind, "result");
  assert.match(
    notice.payload.answer,
    /后台终端软检查 · 项目检查（ID job）[\s\S]*后台终端完成 · 项目检查（ID job）/,
  );
});

const assignment = {
  parent: { id: "secretary", cwd: "/fixture" },
  turn: { id: "parent-turn", original: [] },
  target: "codex",
  snapshot: { model: "fixture" },
  input: { request: "首次需求", request_id: "first" },
};
const replacement = (id) => ({
  ...assignment,
  turn: { id: "follow-turn", original: [{ type: "text", text: "新需求原话" }] },
  input: { request: "替换需求", request_id: "new", task_id: id },
});

test("运行、审批、启动、等待核对和未派发状态均受理同任务新步骤", () => {
  for (const status of [
    "accepted",
    "starting",
    "running",
    "waiting",
    "unknown",
  ]) {
    const data = { tasks: {}, receipts: {}, notices: {} };
    const { task_id: id } = acceptDelegation(data, assignment);
    const task = data.tasks[id];
    task.status = status;
    if (["running", "waiting"].includes(status))
      task.executor = { threadId: "retained" };
    if (status === "waiting") task.request = { localId: "old" };
    queueNotice(data, task, "request:old", {});
    queueNotice(data, task, "result", {});
    const prior = task.steps[0];
    assert.equal(acceptDelegation(data, replacement(id)).task_id, id);
    assert.equal(task.request, null);
    assert.equal(task.status, "accepted");
    assert(prior.supersededAt);
    assert.deepEqual(task.steps[1].original, replacement(id).turn.original);
    for (const notice of Object.values(data.notices)) {
      assert.equal(notice.status, "superseded");
      assert.equal(currentResultNotice(data, notice), false);
    }
    acceptDelegation(data, replacement(id));
    assert.equal(task.steps.length, 2);
  }
});

test("启动中接受替换时复用迟到的原生会话回执，仅提交最新步骤", async () => {
  const data = { tasks: {}, receipts: {}, notices: {} };
  const { task_id: id } = acceptDelegation(data, assignment);
  const creating = Promise.withResolvers();
  const created = Promise.withResolvers();
  const rescan = Promise.withResolvers();
  const published = Promise.withResolvers();
  const starts = [];
  const entry = {
    adapter: { ready: true },
    runtimeId: "runtime",
    subscriptions: new Set(),
  };
  const runner = createDelegationExecution({
    store: {
      read: async () => structuredClone(data),
      change: async (update) => structuredClone(update(data)),
    },
    publish(task) {
      if (task.status === "running") published.resolve();
    },
    wake: rescan.resolve,
    syncRequests() {},
    executor: {
      resolve: async () => entry,
      startParams: () => ({}),
      turnParams: (task) => task.steps.at(-1).id,
      async attach() {},
      async takeover() {},
      async call(_entry, method, params) {
        if (method === "thread/start") {
          creating.resolve();
          return created.promise;
        }
        starts.push(params);
        return { turn: { id: "replacement-turn" } };
      },
    },
  });
  runner.scan(structuredClone(data.tasks));
  await creating.promise;
  acceptDelegation(data, replacement(id));
  runner.scan(structuredClone(data.tasks));
  created.resolve({ thread: { id: "one-native-thread" } });
  await rescan.promise;
  runner.scan(structuredClone(data.tasks));
  await published.promise;
  const task = data.tasks[id];
  assert.equal(task.executor.threadId, "one-native-thread");
  assert.deepEqual(starts, [task.steps[1].id]);
  assert.equal(task.steps[0].turnId, undefined);
  assert.equal(task.steps[1].turnId, "replacement-turn");
});

test("委派受理去重，终态和通知绑定原任务，补问沿用会话", () => {
  const data = { tasks: {}, receipts: {}, notices: {} };
  const args = {
    parent: { id: "owner", cwd: "/work" },
    turn: { id: "turn", original: [{ type: "text", text: "原话" }] },
    target: "codex",
    snapshot: { model: "chosen", effort: "high" },
    input: { request: "核对证据", request_id: "request", scope: "research" },
  };
  const accepted = acceptDelegation(data, args);
  assert.deepEqual(acceptDelegation(data, args), accepted);
  assert.throws(
    () => acceptDelegation(data, { ...args, target: "claude" }),
    /请求标识/,
  );
  const task = data.tasks[accepted.task_id];
  assert.deepEqual(task.original, args.turn.original);
  task.executor = { threadId: "native", runtimeId: "runtime" };
  finishDelegation(data, task, "completed", { answer: "证据" });
  assert.equal(Object.values(data.notices)[0].payload.answer, "证据");
  const follow = {
    ...args,
    snapshot: null,
    input: { request: "补充位置", request_id: "follow", task_id: task.id },
  };
  assert.throws(
    () => acceptDelegation(data, { ...follow, parent: { id: "other" } }),
    /无法继续/,
  );
  assert.equal(acceptDelegation(data, follow).task_id, task.id);
  assert.equal(task.executor.threadId, "native");
  assert.equal(task.selection.effort, "high");
  assert.equal(task.steps.length, 2);
});

test("可选后端缺省关闭，scope 和本机差异独立校验", () => {
  const config = { configDir: "/fixture/path" };
  assert.equal(validateAgyBackend({}, config).enabled, false);
  assert.throws(
    () =>
      validateAgyBackend({ delegates: { codex: { enabled: true } } }, config),
    /选择/,
  );
  assert.throws(
    () =>
      validateAgyBackend(
        { delegates: { codex: { model: "one", providerId: "other" } } },
        config,
      ),
    /选择/,
  );
  const changes = acpFileChanges(
    {
      status: "completed",
      content: [
        {
          type: "diff",
          path: "/workspace/readme.md",
          oldText: "before\n",
          newText: "after\n",
        },
        {
          type: "diff",
          path: "/other/file",
          oldText: null,
          newText: "outside",
        },
      ],
    },
    "/workspace",
  );
  assert.equal(changes.length, 1);
  assert.match(changes[0].diff, /-before\n\+after/);
});

test("原生额度窗口、重置和绝对余额映射到共用账户组件", () => {
  const { rateLimits } = projectAgyQuota({
    quota: {
      "3p-weekly": {
        remaining_fraction: 0,
        reset_time: "2026-11-26T00:00:00Z",
      },
      "gemini-5h": { remaining_fraction: 0.75 },
      "gemini-weekly": { remaining_fraction: 1 },
      credits: { remaining_amount: 137 },
      hidden: { remaining_fraction: 0.5, disabled: true },
      invalid: { remaining_fraction: 10 },
    },
  });
  assert.deepEqual(
    rateLimits.windows.map(({ id, usedPercent, windowDurationMins }) => [
      id,
      usedPercent,
      windowDurationMins,
    ]),
    [
      ["gemini-5h", 25, 300],
      ["gemini-weekly", 0, 10080],
      ["3p-weekly", 100, 10080],
    ],
  );
  assert.equal(
    rateLimits.windows[2].resetsAt,
    Date.parse("2026-11-26T00:00:00Z") / 1000,
  );
  assert.equal(rateLimits.amounts[0].remaining, 137);
});

test("Antigravity 自动处理一次性文件权限，拒绝角色范围外的命令", () => {
  const entry = { nativeId: "native" };
  const params = {
    sessionId: "native",
    options: [
      { kind: "allow_always", optionId: "always" },
      { kind: "allow_once", optionId: "once" },
    ],
  };
  const reply = (toolCall) =>
    answerAcpPermission(entry, "session/request_permission", {
      ...params,
      toolCall,
    }).outcome;
  assert.deepEqual(reply({ kind: "edit" }), {
    outcome: "selected",
    optionId: "once",
  });
  assert.deepEqual(
    reply({ kind: "execute", name: "mcp_claudex_delegation_ask_codex" }),
    {
      outcome: "selected",
      optionId: "once",
    },
  );
  assert.deepEqual(reply({ kind: "execute", name: "run_command" }), {
    outcome: "cancelled",
  });
});

test("项目分页排除委派绑定的原生会话，保留同号的另一后端与下一页", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agy-delegated-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "backends", "agy");
  await mkdir(directory, { recursive: true });
  const hide = createDelegatedThreadIndex(root);
  const page = {
    data: [{ id: "owned" }, { id: "backend:claude:owned" }, { id: "normal" }],
    nextCursor: "next",
  };
  assert.deepEqual(await hide(page), page);
  await writeFile(
    join(directory, "state.json"),
    JSON.stringify({
      tasks: {
        delegated: { target: "codex", executor: { threadId: "owned" } },
      },
    }),
  );
  assert.deepEqual(await hide(page), {
    data: [{ id: "backend:claude:owned" }, { id: "normal" }],
    nextCursor: "next",
  });
});

test("ACP 尚未连接时仍能读取已归档会话及其待派单委派", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agy-offline-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = {
    id: "parent",
    cwd: root,
    name: "隔离会话",
    archived: true,
    turns: [{ id: "turn", status: "completed", items: [] }],
  };
  const state = { sessions: { parent }, tasks: {}, receipts: {}, notices: {} };
  const accepted = acceptDelegation(state, {
    parent,
    turn: parent.turns[0],
    target: "codex",
    snapshot: { model: "fixture", effort: "low" },
    input: { request: "核对材料", request_id: "request" },
  });
  await writeFile(join(root, "state.json"), JSON.stringify(state));
  const adapter = createAgyAdapter({
    backend: { stateDir: root },
    config: { configDir: root, upstreamUrl: "ws://127.0.0.1:8765" },
    emit() {},
  });
  t.after(() => adapter.close());
  assert.equal((await adapter.state()).params.ready, false);
  const { thread } = await adapter.request("thread/read", {
    threadId: parent.id,
    includeTurns: true,
  });
  const agent = thread.turns[0].items[0];
  assert.equal(agent.delegation.taskId, accepted.task_id);
  assert.equal(
    (await adapter.request("thread/read", { threadId: agent.agentThreadId }))
      .thread.id,
    agent.agentThreadId,
  );
  await assert.rejects(
    adapter.request("thread/read", { threadId: "delegation/missing" }),
    /找不到委派任务/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptDelegation,
  currentResultNotice,
  finishDelegation,
  queueNotice,
} from "../src/backends/delegation/delegation-store.mjs";
import {
  buildDelegationSelection,
  resolveSourcePrompt,
} from "../src/backends/delegation/settings.mjs";
import {
  readAgyRole,
  saveAgyRole,
} from "../src/backends/agy/role-settings.mjs";
import { validateAgyBackend } from "../src/backends/agy/configuration.mjs";
import { acpFileChanges } from "../src/backends/agy/acp-files.mjs";
import { projectAgyQuota } from "../src/backends/agy/quota.mjs";
import { answerAcpPermission } from "../src/backends/agy/acp-permissions.mjs";
import { createDelegatedThreadIndex } from "../src/backends/delegation/delegated-threads.mjs";
import { createAgyAdapter } from "../src/backends/agy/adapter.mjs";
import {
  delegationResults,
  saveDelegationResults,
} from "../src/backends/delegation/delegation-results.mjs";
import { createDelegationExecution } from "../src/backends/delegation/delegation-execution.mjs";
import {
  delegationNotice,
  noticeMarker,
} from "../src/backends/agy/delegation-delivery.mjs";
import { createNativeDelegation } from "../src/backends/delegation/native.mjs";
import { runtimeIdentity } from "../src/conversation-manager/address.mjs";

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

test("结果通知按序投递完整调用链，任务保留执行证据", () => {
  const items = Array.from({ length: 148 }, (_, index) => ({
    id: String(index),
    type: index < 143 ? "commandExecution" : "mcpToolCall",
    command: index < 143 ? "fixture check " + index : undefined,
    aggregatedOutput: "fixture command output ".repeat(300),
  }));
  const artifacts = [{ path: "report.md", kind: { type: "add" } }];
  const answer = "已完成核查，产物在工作区。";
  const turn = {
    id: "turn",
    status: "failed",
    error: { message: "仍有一项检查失败" },
    items: [
      ...items,
      { type: "agentMessage", phase: "final_answer", text: answer },
      { id: "patch", type: "fileChange", changes: artifacts },
    ],
  };
  const data = { tasks: {}, receipts: {}, notices: {} };
  const { task_id: id } = acceptDelegation(data, assignment);
  const task = data.tasks[id];
  const step = task.steps[0];
  const results = delegationResults(
    { turns: [turn] },
    turn,
    step,
    { jobs: [], terminals: [] },
    false,
    task.target,
  );
  saveDelegationResults(data, task, results);

  const [notice] = Object.values(data.notices);
  const expected = {
    stepId: step.id,
    status: "failed",
    callChain: step.result.callChain,
    turns: step.result.turns,
    fileTree: [["report.md", [{ type: "add" }]]],
    answer,
    error: turn.error.message,
  };
  assert.deepEqual(notice.payload, expected);
  assert.deepEqual(
    notice.payload.callChain.map(({ callId }) => callId),
    [...items.map(({ id }) => id), "patch"],
  );
  assert.equal(step.result.evidence.length, items.length);
  assert.equal(
    step.result.evidence[0].output,
    items[0].aggregatedOutput.slice(-6000),
  );
  assert.deepEqual(step.result.turns, [
    { turnId: turn.id, status: "failed", triggers: [] },
  ]);

  const legacy = {
    ...notice,
    payload: { status: task.status, ...step.result },
  };
  assert(Buffer.byteLength(JSON.stringify(legacy.payload)) > 600000);
  const [{ text }] = delegationNotice(legacy, task).prompt;
  assert(text.startsWith(noticeMarker(notice.id)));
  assert(text.includes(task.id));
  assert.deepEqual(JSON.parse(text.split("\n").at(-1)), {
    taskId: task.id,
    ...expected,
  });
  assert(Buffer.byteLength(text) < 24000);
  assert(text.indexOf('"callChain"') < text.indexOf('"answer"'));
  assert.equal(legacy.payload.evidence.length, items.length);
});

test("长文件清单折叠公共目录，回投保留所有路径及完整结论", () => {
  const paths = Array.from(
    { length: 120 },
    (_, index) => `src/file-${index}.mjs`,
  );
  const artifacts = paths.map((path) => ({ path, kind: { type: "add" } }));
  const first = ["已修改 120 个文件", ...paths].join("\n");
  const stages = [
    {
      turnId: "first",
      status: "completed",
      triggers: [],
      answer: first,
      artifacts,
      evidence: [{ id: "check", output: "完整命令结果" }],
    },
    {
      turnId: "second",
      status: "completed",
      triggers: [],
      answer: "后续验证通过",
      artifacts: [],
      evidence: [{ id: "follow-up", output: "完整后续结果" }],
    },
  ];
  const data = { notices: {} };
  const task = {
    id: "task",
    parentId: "parent",
    target: "codex",
    status: "running",
    steps: [{ id: "step" }],
  };
  saveDelegationResults(data, task, { pending: false, stages });

  const notice = data.notices["step:result"];
  const { result } = task.steps[0];
  const full = `## 当前委派\n\n${first}\n\n## 原生续跑 · second\n\n后续验证通过`;
  assert.equal(result.answer, full);
  assert.deepEqual(
    result.evidence,
    stages.flatMap(({ evidence }) => evidence),
  );
  assert.deepEqual(result.artifacts, artifacts);
  assert.equal(task.status, "completed");
  assert.equal(notice.payload.status, task.status);
  assert.equal(notice.payload.answer, full);
  assert.deepEqual(notice.payload.fileTree, [
    ["src", [], paths.map((path) => [path.slice(4), [{ type: "add" }]])],
  ]);
  assert.equal(notice.payload.evidence, undefined);
  for (const record of [
    notice,
    { ...notice, payload: { status: task.status, ...result } },
  ]) {
    const [{ text }] = delegationNotice(record, task).prompt;
    assert(text.startsWith(noticeMarker(notice.id)));
    assert.deepEqual(
      JSON.parse(text.split("\n").at(-1)),
      JSON.parse(JSON.stringify({ taskId: task.id, ...notice.payload })),
    );
  }
});

test(
  "旧排队记录使用步骤完整结果，恢复时按实际提交的正文匹配",
  { timeout: 10000 },
  async () => {
    const configDir = await mkdtemp(
      join(tmpdir(), "claudex-delegation-notice-"),
    );
    const directory = join(configDir, "delegation");
    const stateFile = join(directory, "state.json");
    const backend = { id: "codex", type: "codex", url: "ws://localhost:8765" };
    const payload = {
      status: "completed",
      answer: "fixture answer\n" + "超长正文🧪".repeat(2000),
      evidence: [{ output: "fixture command output" }],
    };
    const tasks = {};
    const notices = {};
    for (const status of ["queued", "submitting"]) {
      tasks[status] = {
        id: status,
        parentId: status,
        sourceRuntime: runtimeIdentity(backend),
        target: "claude",
        status: "completed",
        steps: [{ id: status, result: payload }],
      };
      notices[status + ":result"] = {
        id: status + ":result",
        stepId: status,
        taskId: status,
        parentId: status,
        kind: "result",
        status,
        payload:
          status === "queued"
            ? { status: "completed", answer: "fixture answer" }
            : payload,
      };
    }
    const legacy = Promise.withResolvers();
    const compact = Promise.withResolvers();
    let submitted;
    const delivery = {
      async readThread(threadId) {
        return { threadId };
      },
      async deliver({ body }) {
        submitted = body;
        return { status: "queued" };
      },
      async reconcile({ id, body }) {
        (id === "submitting" ? legacy : compact).resolve(body);
        return { status: "queued" };
      },
    };
    const runtime = createNativeDelegation({
      config: { configDir, upstreamUrl: backend.url },
      backendEntry: () => ({
        backend,
        adapter: { ready: true, conversationManager: delivery },
      }),
      changed() {},
    });
    try {
      await mkdir(directory);
      await writeFile(stateFile, JSON.stringify({ tasks, notices }));
      await runtime.start();
      assert.equal(
        await legacy.promise,
        JSON.stringify({ task_id: "submitting", ...payload }),
      );
      const recovered = await compact.promise;
      assert.equal(recovered, submitted);
      const body = JSON.parse(recovered);
      assert.equal(body.task_id, "queued");
      assert.equal(body.status, payload.status);
      assert.equal(body.answer, payload.answer);
      assert.equal(body.stepId, "queued");
      assert.equal(body.evidence, undefined);
      const saved = JSON.parse(await readFile(stateFile, "utf8"));
      assert.deepEqual(saved.tasks.queued.steps[0].result, payload);
      assert.deepEqual(saved.notices["queued:result"].payload, {
        stepId: "queued",
        status: body.status,
        answer: body.answer,
      });
    } finally {
      runtime.close();
      await rm(configDir, { recursive: true, force: true });
    }
  },
);

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
  assert.equal(
    validateAgyBackend({ delegates: { codex: { enabled: true } } }, config)
      .delegates.codex.enabled,
    true,
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

test("委派三端分别解析提示词，默认项读取已保存的角色正文", async (t) => {
  const configDir = await mkdtemp(
    join(tmpdir(), "claudex-delegation-prompts-"),
  );
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const settings = validateAgyBackend(
    {
      delegationPrompts: [
        { id: "codex", name: "Codex 执行端", content: "核对代码" },
        { id: "secretary", name: "Antigravity 秘书", content: "汇报交付" },
      ],
      delegates: { codex: { promptId: "codex" } },
      secretaryPromptId: "secretary",
    },
    { configDir },
  );
  const { defaultContent } = await readAgyRole(settings.stateDir);
  assert.equal(await resolveSourcePrompt(settings, "claude"), defaultContent);
  await saveAgyRole(settings.stateDir, "已保存的角色正文");
  assert.equal(
    await resolveSourcePrompt(settings, "claude"),
    "已保存的角色正文",
  );
  assert.equal(await resolveSourcePrompt(settings, "codex"), "核对代码");
  assert.equal(await resolveSourcePrompt(settings, "agy"), "汇报交付");
  assert.deepEqual(buildDelegationSelection(settings, "codex"), {
    model: "",
    effort: "",
    providerId: "",
  });
  assert.equal(settings.delegationSourcePrompts.codex, "codex");
  assert.equal(settings.delegationSourcePrompts.agy, "secretary");
  assert.throws(
    () =>
      validateAgyBackend(
        { delegationSourcePrompts: { agy: "missing" } },
        { configDir },
      ),
    /委派提示词/,
  );
});

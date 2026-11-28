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
import { traceId } from "../src/backends/delegation/trace-ids.mjs";
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
  check.items.push({
    type: "agentMessage",
    phase: "final_answer",
    text: "仍在运行，已安排下次检查。",
  });
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
  assert.equal(
    partial.stages[0].answer,
    "**阶段说明**\n\n工作过程\n\n**最终结论**\n\n已启动终端",
  );
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
  assert.equal(result.stages[2].conclusion, "");
  assert.equal(
    notice.payload.answer,
    "## 派单轮答复\n\n已启动终端\n\n## 后台终端软检查 · 项目检查（ID job）\n\n仍在运行，已安排下次检查。",
  );
  assert.equal(notice.payload.preview, "已启动终端");
  assert.equal(task.steps[0].result.conclusion, "");
  assert.match(
    task.steps[0].result.answer,
    /后台终端软检查 · 项目检查（ID job）[\s\S]*后台终端完成 · 项目检查（ID job）/,
  );
});

test("补问只等待本步骤的后台任务与原生终端", () => {
  const prior = {
    id: "prior",
    status: "completed",
    items: [{ id: "prior-native", type: "commandExecution" }],
  };
  const current = {
    id: "current",
    status: "completed",
    items: [{ id: "current-native", type: "commandExecution" }],
  };
  const step = { acceptedAt: 10 };
  const oldJob = {
    id: "old",
    startedAt: 1,
    status: "running",
    delivery: "pending",
  };
  const priorTerminals = [
    { processId: "old", itemId: "old" },
    { processId: "prior-process", itemId: "prior-native" },
  ];
  const pending = (jobs, terminals) =>
    delegationResults(
      { turns: [prior, current] },
      current,
      step,
      { jobs, terminals },
      false,
      "codex",
    ).pending;
  assert.equal(pending([oldJob], priorTerminals), false);
  const newJob = { ...oldJob, id: "new", startedAt: 10 };
  assert.equal(pending([oldJob, newJob], priorTerminals), true);
  assert.equal(
    pending(
      [oldJob],
      [
        ...priorTerminals,
        { processId: "current-process", itemId: "current-native" },
      ],
    ),
    true,
  );
  assert.equal(
    pending(
      [
        oldJob,
        {
          ...newJob,
          delivery: "suppressed",
          native: { processId: "current-process" },
        },
      ],
      [
        ...priorTerminals,
        { processId: "current-process", itemId: "current-native" },
      ],
    ),
    false,
  );
});

const assignment = {
  parent: { id: "secretary", cwd: "/fixture" },
  turn: { id: "parent-turn", original: [] },
  target: "codex",
  snapshot: { model: "fixture" },
  input: { request: "首次需求", request_id: "first" },
};

test("149 次调用的回投载荷保留答复与状态，调用证据通过步骤索引查阅", () => {
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
    stepId: traceId(step.id),
    status: "failed",
    context: { compactCount: 0 },
    answer,
    preview: answer,
    error: turn.error.message,
  };
  assert.deepEqual(notice.payload, expected);
  assert.deepEqual(
    step.result.callChain.map(({ callId }) => callId),
    [...items.map(({ id }) => id), "patch"],
  );
  assert.equal(step.result.evidence.length, items.length);
  assert.equal(
    step.result.evidence[0].output,
    items[0].aggregatedOutput.slice(-6000),
  );
  assert.deepEqual(step.result.turns, [
    { turnId: turn.id, status: "failed", triggers: [], callCount: 149 },
  ]);
  assert.deepEqual(step.result.artifacts, artifacts);

  const { deliveryAnswer, deliveryPreview, ...oldResult } = step.result;
  const legacy = {
    ...notice,
    payload: { status: task.status, ...oldResult },
  };
  const legacyTask = { ...task, steps: [{ ...step, result: oldResult }] };
  assert(Buffer.byteLength(JSON.stringify(legacy.payload)) > 600000);
  const [{ text }] = delegationNotice(legacy, legacyTask).prompt;
  assert.deepEqual(
    delegationNotice(legacy, legacyTask).items[0].context,
    expected.context,
  );
  assert(text.startsWith(noticeMarker(notice.id)));
  assert(!text.includes(task.id));
  assert(!text.includes(step.id));
  assert.deepEqual(JSON.parse(text.split("\n").at(-1)), {
    taskId: traceId(task.id),
    stepId: expected.stepId,
    status: expected.status,
    context: expected.context,
    answer: expected.answer,
    error: expected.error,
  });
  assert(Buffer.byteLength(text) < 1000);
  assert.equal(legacy.payload.evidence.length, items.length);
});

test("续跑答复较长时仍按轮次逐字回投，步骤保留阶段说明和调用证据", () => {
  const paths = Array.from(
    { length: 120 },
    (_, index) => `src/file-${index}.mjs`,
  );
  const artifacts = paths.map((path) => ({ path, kind: { type: "add" } }));
  const first = ["已修改 120 个文件", ...paths].join("\n");
  const final =
    "  后续验证通过。\n\n```text\nsrc/\n├── file-0.mjs\n└── file-1.mjs\n```\n" +
    "逐字保留 🧪\n".repeat(2500);
  const stages = [
    {
      turnId: "first",
      status: "completed",
      triggers: [],
      answer:
        first +
        "\n\n本次引用的文件如下。\n\n```text\nsrc/\n├── file-0.mjs\n└── file-1.mjs\n```",
      artifacts,
      evidence: [{ id: "check", output: "完整命令结果" }],
    },
    {
      turnId: "second",
      status: "completed",
      triggers: [],
      answer: "阶段说明\n\n" + final,
      conclusion: final,
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
  assert(result.answer.includes("├── file-0.mjs"));
  assert.deepEqual(
    result.evidence,
    stages.flatMap(({ evidence }) => evidence),
  );
  assert.deepEqual(result.artifacts, artifacts);
  assert.equal(task.status, "completed");
  assert.deepEqual(notice.payload, {
    stepId: "step",
    status: task.status,
    answer: `## 派单轮答复\n\n${stages[0].answer}\n\n## 原生续跑 · 第 2 轮\n\n${final}`,
    preview:
      "已修改 120 个文件 src/file-0.mjs src/file-1.mjs src/file-2.mjs src/file-3.mjs src...",
  });
  assert.equal(result.deliveryAnswer, notice.payload.answer);
  assert.equal(result.conclusion, final);
  const updated = structuredClone(task);
  Object.assign(updated.steps[0].result, {
    deliveryAnswer: "迟到更新",
    deliveryPreview: "迟到预览",
  });
  for (const source of [task, updated]) {
    const [{ text }] = delegationNotice(notice, source).prompt;
    assert(text.startsWith(noticeMarker(notice.id)));
    assert.deepEqual(
      JSON.parse(text.split("\n").at(-1)),
      JSON.parse(JSON.stringify({ taskId: task.id, ...notice.payload })),
    );
  }
});

test("已排队和已经执行的委派均以用户主动停止状态回投", async () => {
  const data = { tasks: {}, receipts: {}, notices: {} };
  const { task_id: id } = acceptDelegation(data, assignment);
  const task = data.tasks[id];
  const runner = createDelegationExecution({
    store: {
      read: async () => data,
      change: async (change) => change(data),
    },
    wake() {},
    publish() {},
  });
  await runner.cancel(task.parentId, id);
  assert.equal(task.status, "stopped_by_user");
  assert(currentResultNotice(data, Object.values(data.notices)[0]));
  acceptDelegation(data, {
    ...assignment,
    input: { ...assignment.input, task_id: id, request_id: "follow-up" },
  });
  task.status = "running";
  task.steps.at(-1).stopRequested = true;
  const plan = "  研究结论与计划\n";
  const turn = {
    id: "native-turn",
    status: "interrupted",
    items: [
      { type: "agentMessage", phase: "commentary", text: "已开始" },
      { type: "plan", phase: "final_answer", text: plan },
    ],
  };
  saveDelegationResults(
    data,
    task,
    delegationResults(
      { turns: [turn] },
      turn,
      task.steps.at(-1),
      { jobs: [], terminals: [] },
      false,
      "claude",
    ),
  );
  const notice = data.notices[task.steps.at(-1).id + ":result"];
  assert(currentResultNotice(data, notice));
  assert.equal(
    delegationNotice(notice, task).items[0].status,
    "stopped_by_user",
  );
  assert.equal(notice.payload.answer, plan);
  assert.equal(task.steps.at(-1).result.turns[0].status, "interrupted");
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
    /委派失败.*请求 ID/,
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
    /续问失败.*当前会话与接收端/,
  );
  const beforeConflict = structuredClone(data);
  assert.throws(
    () =>
      acceptDelegation(data, {
        ...follow,
        input: { ...follow.input, scope: "implementation" },
      }),
    {
      message:
        "委派续问失败：原任务范围为 research，本次请求范围为 implementation。请用 implementation 新建委派任务，或改用 research 续问。",
    },
  );
  assert.deepEqual(data, beforeConflict);
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

test("Antigravity 自动同意原生工具请求，优先选择允许一次", () => {
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
    outcome: "selected",
    optionId: "once",
  });
  assert.deepEqual(
    answerAcpPermission(entry, "session/request_permission", {
      ...params,
      options: [{ kind: "allow_always", optionId: "always" }],
    }).outcome,
    {
      outcome: "selected",
      optionId: "always",
    },
  );
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
  const selection = { model: "fixture", effort: "low" };
  const accepted = acceptDelegation(state, {
    parent,
    turn: parent.turns[0],
    target: "codex",
    snapshot: selection,
    input: {
      request: "核对材料",
      request_id: "request",
      taskSummary: " 核对材料引用 ",
    },
  });
  const old = acceptDelegation(state, {
    parent,
    turn: parent.turns[0],
    target: "claude",
    snapshot: selection,
    input: { request: "检查来源", request_id: "old" },
  });
  acceptDelegation(state, {
    parent,
    turn: parent.turns[0],
    target: "codex",
    input: {
      task_id: accepted.task_id,
      request: "追加材料",
      request_id: "follow-up",
      taskSummary: "复核补充材料",
    },
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
  const [agent, unnamed] = thread.turns[0].items;
  assert.equal(agent.delegation.taskId, accepted.task_id);
  assert.equal(agent.delegation.taskSummary, "核对材料引用");
  assert.equal(agent.prompt, "核对材料");
  assert.equal(unnamed.delegation.taskId, old.task_id);
  assert.equal(unnamed.delegation.taskSummary, undefined);
  assert.equal(unnamed.prompt, "检查来源");
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

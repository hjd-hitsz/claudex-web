import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAcpSessions } from "../../server/src/backends/agy/acp-session.mjs";
import { createAgyStore } from "../../server/src/backends/agy/session-store.mjs";
import {
  delegationNotice,
  noticeMarker,
} from "../../server/src/backends/agy/delegation-delivery.mjs";
import {
  receiveIpc,
  sendIpc,
} from "../../server/src/backends/agy/worker-ipc.mjs";
import { answerAcpPermission } from "../../server/src/backends/agy/acp-permissions.mjs";
import { findCli } from "../../server/src/backends/cli-installation.mjs";
import {
  readAgyRole,
  saveAgyRole,
} from "../../server/src/backends/agy/role-settings.mjs";

const cache = resolve(".cache");
await mkdir(cache, { recursive: true });
const root = await mkdtemp(join(cache, "agy-native-"));
const profile = join(root, "profile");
const cwd = join(root, "project");
const stateDir = join(root, "state");
const socketPath = join(root, "mcp.sock");
await mkdir(join(profile, "antigravity-cli"), { recursive: true, mode: 0o700 });
await mkdir(cwd);
await writeFile(
  join(profile, "antigravity-cli", "settings.json"),
  JSON.stringify({
    auth: { type: "gemini-api-key" },
    modelProvider: "gemini",
    permissions: { allow: ["mcp(claudex_delegation)"] },
  }),
  { mode: 0o600 },
);
const executable = join(root, "agy");
const quote = (path) => "'" + path.replaceAll("'", "'\"'\"'") + "'";
const home = homedir();
const binary = process.env.AGY_EXECUTABLE || (await findCli("agy"));
await writeFile(
  executable,
  `#!/bin/sh
exec bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /run/user --bind ${quote(root)} ${quote(root)} --bind ${quote(profile)} ${quote(join(home, ".gemini"))} --tmpfs ${quote(join(home, ".config"))} --tmpfs ${quote(join(home, ".local/share"))} --unsetenv DBUS_SESSION_BUS_ADDRESS --unsetenv XDG_RUNTIME_DIR --unsetenv GOOGLE_APPLICATION_CREDENTIALS ${quote(binary)} "$@" --disable-telemetry
`,
  { mode: 0o700 },
);
const events = [];
const requests = [];
let returnedResult;
const evidenceMarker = "FIXTURE_DELEGATION_LOG";
const mcpCalls = [];
const mcpMethods = [];
const clients = new Set();
const mcp = createNetServer((socket) => {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => {});
  receiveIpc(socket, ({ id, method, params }) => {
    mcpMethods.push(method);
    const entry = sessions.tokens.get(params.token);
    if (!entry)
      return sendIpc(socket, { id, error: "Expired test MCP session" });
    let result = {};
    if (method === "mcp/list")
      result = ["codex", "claude", "read_delegation_step"];
    if (method === "mcp/ready") {
      entry.toolsReady = true;
      entry.ready?.();
    }
    if (method === "mcp/call") {
      mcpCalls.push(params);
      result =
        params.tool === "read_delegation_step"
          ? { raw: { outputs: ["FIXTURE_NATIVE_STEP_OUTPUT"] } }
          : { task_id: "native-fixture", status: "accepted" };
    }
    sendIpc(socket, { id, result });
  });
});
mcp.listen(socketPath);
await once(mcp, "listening");
const { chmod } = await import("node:fs/promises");
await chmod(socketPath, 0o600);
let sequence = 0;
let holdResponse;
const proxy = createServer(async (request, response) => {
  const url = new URL(request.url, "http://not-forwarded.invalid");
  if (url.hostname !== "agy-fixture.invalid")
    return response.writeHead(502).end();
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (request.method === "GET")
    return response
      .writeHead(200, { "content-type": "application/json" })
      .end('{"models":[]}');
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const tools = (body.tools || []).flatMap(
    (set) => set.functionDeclarations || [],
  );
  const serialized = JSON.stringify(body.contents || []);
  if (serialized.includes(noticeMarker("fixture-step:result"))) {
    returnedResult = {
      answer: serialized.includes("FIXTURE_DELEGATION_ANSWER"),
      artifact: serialized.includes("report.md"),
      evidence: serialized.includes(evidenceMarker),
      chain: serialized.includes("fixture-call"),
    };
  }
  const instruction = JSON.stringify(body.systemInstruction || "");
  requests.push({
    model: /\/models\/([^:]+):/.exec(url.pathname)?.[1],
    tools: tools.map(({ name }) => name),
    role: instruction.includes("你是用户的秘书"),
    customRole: instruction.includes("CLAUDEX_ROLE_OVERRIDE_TEST"),
    presetRole: instruction.includes("CLAUDEX_SECRETARY_PRESET_TEST"),
    image: serialized.includes("inlineData"),
  });
  await holdResponse?.();
  const initial = serialized.includes("AGY_NATIVE_FIRST");
  const called = body.contents?.some(({ parts }) =>
    parts?.some(({ functionResponse }) =>
      functionResponse?.name?.includes("ask_codex"),
    ),
  );
  const target = tools.find(
    ({ name }) => name === "mcp_claudex_delegation_ask_codex",
  );
  const lookup = tools.find(
    ({ name }) => name === "mcp_claudex_delegation_read_delegation_step",
  );
  const resultNotice = serialized.includes(noticeMarker("fixture-step:result"));
  const gotStep = serialized.includes("FIXTURE_NATIVE_STEP_OUTPUT");
  const part =
    resultNotice && lookup && !gotStep
      ? {
          functionCall: {
            name: lookup.name,
            args: {
              toolSummary: "核对执行记录",
              taskId: "fixture-task",
              stepId: "fixture-step",
              callId: "fixture-call",
            },
          },
        }
      : initial && !called && target
        ? {
            functionCall: {
              name: target.name,
              args: {
                toolSummary: "交给 Codex 核对证据",
                request: "核对测试内容",
                request_id: "native-probe",
                scope: "research",
              },
            },
          }
        : { text: called ? "原生委派已受理" : "原生秘书回复" };
  const answer = {
    responseId: "agy-fixture-" + ++sequence,
    candidates: [
      {
        index: 0,
        content: { role: "model", parts: [part] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 12,
      candidatesTokenCount: 5,
      totalTokenCount: 17,
    },
  };
  if (url.pathname.includes("streamGenerateContent"))
    response
      .writeHead(200, { "content-type": "text/event-stream" })
      .end("data: " + JSON.stringify(answer) + "\n\n");
  else
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(answer));
});
proxy.on("connect", (_request, socket) =>
  socket.end("HTTP/1.1 502 Isolated test\r\n\r\n"),
);
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const backend = {
  stateDir,
  executable,
  proxy: { mode: "http", host: "127.0.0.1", port: proxy.address().port },
};
process.env.GEMINI_API_KEY = "isolated-fixture";
process.env.GOOGLE_GEMINI_BASE_URL = "http://agy-fixture.invalid";
const store = createAgyStore(stateDir);
const execution = {
  acpRequest: answerAcpPermission,
  async finishNotice(id, turn) {
    await store.change((data) => {
      data.notices[id].status =
        turn.status === "completed" ? "delivered" : "uncertain";
    });
  },
  async prepareMcp(entry) {
    if (entry.toolsReady) return;
    let timer;
    try {
      await new Promise((resolve, reject) => {
        entry.ready = resolve;
        timer = setTimeout(
          () => reject(new Error("原生 MCP 工具发现超时")),
          10000,
        );
      });
    } finally {
      clearTimeout(timer);
    }
  },
};
const sessions = createAcpSessions({
  store,
  getBackend: () => backend,
  socket: socketPath,
  execution,
  emit: (event) => events.push(event),
});
try {
  const version = await sessions.connect(executable);
  const catalogue = await sessions.catalogue();
  assert(catalogue.models.length, "首次提交前须返回原生模型目录");
  assert(catalogue.models.every(({ model }) => model));
  assert.equal(requests.length, 0, "读取目录不应提交模型请求");
  const alternate = catalogue.models.find(
    (entry) => entry.model === "gemini-3.8-flash" && !entry.isDefault,
  );
  assert(alternate, "隔离目录须包含可用于续接回归的非默认 Gemini 模型");
  const id = "native";
  await store.change((data) => {
    data.sessions[id] = { id, cwd, turns: [] };
  });
  let session = store.session(await store.read(), id);
  const image =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRioAAAAASUVORK5CYII=";
  const first = await sessions.prompt(
    session,
    {
      id: "first",
      items: [
        {
          id: "initial-user",
          type: "userMessage",
          content: [{ type: "text", text: "AGY_NATIVE_FIRST" }],
        },
      ],
    },
    { delegateTo: "codex", model: alternate.model },
    [
      { type: "text", text: "AGY_NATIVE_FIRST" },
      { type: "image", mimeType: "image/png", data: image },
    ],
  );
  assert.equal(first.turn.status, "completed", first.turn.error?.message);
  const requestedModel = requests.find(({ role }) => role)?.model;
  assert(requestedModel?.startsWith(alternate.model), requestedModel);
  const initial = events.findIndex(
    ({ method, params }) =>
      method === "item/completed" &&
      params.turnId === "first" &&
      params.item.type === "userMessage",
  );
  const delta = events.findIndex(
    ({ method, params }) =>
      method === "item/agentMessage/delta" && params.turnId === "first",
  );
  assert.ok(initial >= 0 && initial < delta, "用户输入先于助手增量发布");
  assert(
    mcpCalls.some(({ tool }) => tool === "ask_codex"),
    JSON.stringify(requests),
  );
  assert.deepEqual(Object.keys(mcpCalls[0].input).sort(), [
    "request",
    "request_id",
    "scope",
  ]);
  assert(requests.some(({ role, image }) => role && image));
  assert(
    requests.every(
      ({ tools }) =>
        !tools.some((name) =>
          ["run_command", "define_subagent", "invoke_subagent"].includes(name),
        ),
    ),
  );
  sessions.discard(id);
  session = store.session(await store.read(), id);
  const replay = await sessions.replay(session);
  assert(
    replay.some(({ sessionUpdate }) => sessionUpdate === "user_message_chunk"),
  );
  // Keep an open ACP session to exercise replacing the role on the next turn.
  await sessions.open(session);
  assert.equal((await store.read()).sessions[id].model, alternate.model);
  const { defaultContent } = await readAgyRole(stateDir);
  await saveAgyRole(stateDir, "CLAUDEX_ROLE_OVERRIDE_TEST");
  const checkpoint = requests.length;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  holdResponse = () => {
    entered.resolve();
    return release.promise;
  };
  const running = sessions.prompt(session, { id: "second", items: [] }, {}, [
    { type: "text", text: "回复一行" },
  ]);
  try {
    await Promise.race([entered.promise, running]);
    assert(sessions.active.has(id), "应在轮次执行期间保存默认角色");
    await saveAgyRole(stateDir, defaultContent);
  } finally {
    holdResponse = undefined;
    release.resolve();
  }
  const second = await running;
  assert.equal(second.turn.status, "completed", second.turn.error?.message);
  assert(requests.length > checkpoint);
  assert.equal(
    requests.slice(checkpoint).find(({ customRole }) => customRole)?.model,
    requestedModel,
  );
  assert.equal((await store.read()).sessions[id].model, alternate.model);
  assert(
    requests
      .slice(checkpoint)
      .every(({ role, customRole }) => !role && customRole),
    "续接提交的原生模型请求须使用自定义角色",
  );
  assert.equal((await store.read()).sessions[id].nativeId, session.nativeId);
  assert(second.turn.items.some(({ type }) => type === "agentMessage"));
  assert(events.some(({ method }) => method === "thread/tokenUsage/updated"));
  const resetCheckpoint = requests.length;
  const third = await sessions.prompt(session, { id: "third", items: [] }, {}, [
    { type: "text", text: "再次回复一行" },
  ]);
  assert.equal(third.turn.status, "completed", third.turn.error?.message);
  assert(requests.length > resetCheckpoint);
  assert(
    requests
      .slice(resetCheckpoint)
      .every(({ role, customRole }) => role && !customRole),
    "恢复默认后原生模型请求须使用内置角色",
  );
  backend.delegationPrompts = [
    { id: "secretary-proof", content: "CLAUDEX_SECRETARY_PRESET_TEST" },
  ];
  backend.delegationSourcePrompts = { agy: "secretary-proof" };
  const presetCheckpoint = requests.length;
  const bound = await sessions.prompt(
    session,
    { id: "preset", items: [] },
    {},
    [{ type: "text", text: "核对秘书预设" }],
  );
  assert.equal(bound.turn.status, "completed", bound.turn.error?.message);
  assert(requests.length > presetCheckpoint);
  assert(
    requests
      .slice(presetCheckpoint)
      .every(({ role, presetRole }) => !role && presetRole),
  );
  backend.delegationSourcePrompts = { agy: "" };
  const blocked = Promise.withResolvers();
  const resumeModel = Promise.withResolvers();
  holdResponse = () => {
    holdResponse = undefined;
    blocked.resolve();
    return resumeModel.promise;
  };
  const old = sessions.prompt(session, { id: "interrupted", items: [] }, {}, [
    { type: "text", text: "等待被中断" },
  ]);
  const timeout = new Promise((_, reject) => {
    const signal = AbortSignal.timeout(12000);
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
  try {
    await Promise.race([blocked.promise, timeout]);
    const next = sessions.replace(
      session,
      { id: "replacement", items: [] },
      {},
      [{ type: "text", text: "现在执行新的要求" }],
    );
    const [before, after] = await Promise.race([
      Promise.all([old, next]),
      timeout,
    ]);
    assert.equal(before.turn.status, "interrupted");
    assert.equal(after.turn.status, "completed", after.turn.error?.message);
    assert.equal((await store.read()).sessions[id].nativeId, session.nativeId);
  } finally {
    resumeModel.resolve();
  }
  const task = {
    id: "fixture-task",
    parentId: id,
    target: "codex",
    status: "completed",
    steps: [{ id: "fixture-step" }],
  };
  const notice = {
    id: "fixture-step:result",
    taskId: task.id,
    parentId: id,
    stepId: task.steps[0].id,
    kind: "result",
    status: "queued",
    payload: {
      status: "completed",
      answer: "FIXTURE_DELEGATION_ANSWER",
      callChain: [
        {
          callId: "fixture-call",
          tool: "exec_command",
          turnId: "fixture-turn",
        },
      ],
      artifacts: [{ path: "report.md", kind: { type: "add" } }],
      evidence: Array.from({ length: 148 }, () => ({
        type: "commandExecution",
        output: evidenceMarker.repeat(270),
      })),
    },
  };
  await store.change((data) => {
    data.tasks[task.id] = task;
    data.notices[notice.id] = notice;
  });
  const { prompt, ...record } = delegationNotice(notice, task);
  const returned = await sessions.prompt(
    session,
    record,
    { notice: true },
    prompt,
  );
  assert.equal(returned.turn.status, "completed", returned.turn.error?.message);
  assert.deepEqual(returnedResult, {
    answer: true,
    artifact: true,
    evidence: false,
    chain: true,
  });
  assert.equal((await store.read()).notices[notice.id].status, "delivered");
  assert.deepEqual(
    mcpCalls.find(({ tool }) => tool === "read_delegation_step")?.input,
    { taskId: "fixture-task", stepId: "fixture-step", callId: "fixture-call" },
  );
  console.log("原生 ACP 从回投取得调用 ID，并调用 MCP 读取步骤详情。");
  console.log(
    `agy ${version} 原生 ACP 已验证 MCP、历史回放、默认角色更新、Antigravity 独立发起预设及打断后在同一会话执行新要求`,
  );
} catch (error) {
  console.error(
    JSON.stringify({
      requests,
      mcpMethods,
      mcpCalls: mcpCalls.map(({ tool }) => tool),
      events: events.map(({ method }) => method),
    }),
  );
  throw error;
} finally {
  sessions.close();
  for (const socket of clients) socket.destroy();
  mcp.close();
  proxy.closeAllConnections();
  proxy.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

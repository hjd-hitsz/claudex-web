import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import {
  mcpConfig,
  taskRequest,
} from "../../packages/background-terminal/client.mjs";
import { connectCodex } from "../../packages/background-terminal/codex.mjs";
import { fullAccessParams } from "../../client/src/domain/execution-policy.js";
import { createBackgroundService } from "../../server/src/backends/codex/background-service.mjs";
import { createCodexAdapter } from "../../server/src/backends/codex/adapter.mjs";
import { createBackendConfiguration } from "../../server/src/backends/configuration.mjs";
import { nativeDelegationStatePath } from "../../server/src/backends/delegation/activity.mjs";
import { createDelegationRuntime } from "../../server/src/backends/delegation/runtime.mjs";
import { createStorage } from "../../server/src/backends/storage.mjs";
import { readConfig } from "../../server/src/config.mjs";
import { runtimeIdentity } from "../../server/src/conversation-manager/address.mjs";

const dir = mkdtempSync(join(tmpdir(), "claudex-research-"));
console.log("隔离证据目录", dir);
const cwd = join(dir, "work");
const codexHome = join(dir, "codex");
const home = join(dir, "home");
for (const path of [cwd, codexHome, home]) mkdirSync(path);
writeFileSync(join(cwd, "input.txt"), "READ_OK\n");
writeFileSync(
  join(cwd, "fixture.test.cjs"),
  'require("node:test")("implementation writes", () => require("node:assert/strict").equal(require("node:fs").readFileSync("implementation.txt", "utf8"), "WRITE_OK"));\n',
);
const binary = process.env.CODEX_BINARY || "codex";
console.log(
  "原生二进制",
  execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
);

const wire = [];
const nativeApprovals = [];
const log = (entry) =>
  appendFileSync(join(dir, "rpc.jsonl"), JSON.stringify(entry) + "\n");
let phase = "";
let sequence = 0;
let replies = [];
const modelCalls = [];
const model = http.createServer(async (request, response) => {
  if (request.url === "/probe") return response.end("LOOPBACK_OK");
  const body = JSON.parse(
    Buffer.concat(await Array.fromAsync(request)).toString(),
  );
  const record = {
    phase,
    tools: body.tools.flatMap(({ name, tools }) =>
      name ? [name] : (tools || []).map(({ name }) => name),
    ),
    outputs: body.input.filter(({ type }) =>
      type.endsWith("function_call_output"),
    ),
  };
  modelCalls.push(record);
  log({ direction: "provider", ...record });
  const id = "fixture_" + ++sequence;
  const title = body.text?.format?.type === "json_schema";
  const item = (!title && replies.shift()) || {
    type: "message",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: title ? '{"title":"Isolated verification"}' : phase + "_DONE",
      },
    ],
  };
  const events = [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item: { id: "item_" + id, ...item } },
    {
      type: "response.completed",
      response: {
        id,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    events
      .map(
        (event) =>
          "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n",
      )
      .join(""),
  );
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const base = "http://127.0.0.1:" + model.address().port;
writeFileSync(
  join(codexHome, "config.toml"),
  `model = "gpt-5.4"
model_provider = "fixture"
web_search = "disabled"
thread_unload_delay_secs = 0

[model_providers.fixture]
name = "Isolated Responses fixture"
base_url = "${base}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
`,
);

const reserve = http.createServer().listen(0, "127.0.0.1");
await once(reserve, "listening");
const nativeUrl = "ws://127.0.0.1:" + reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const native = spawn(binary, ["app-server", "--listen", nativeUrl], {
  cwd,
  env: {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: codexHome,
    LANG: "C.UTF-8",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
native.stderr.on("data", (bytes) =>
  appendFileSync(join(dir, "native.log"), bytes),
);
const proxy = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await once(proxy, "listening");
proxy.on("connection", (client) => {
  const upstream = new WebSocket(nativeUrl);
  const pending = [];
  client.on("message", (bytes) => {
    const data = JSON.parse(bytes);
    wire.push(data);
    log({ direction: "request", data });
    if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes.toString());
    else pending.push(bytes.toString());
  });
  upstream.on("open", () => {
    for (const message of pending) upstream.send(message);
  });
  upstream.on("message", (bytes) => {
    const data = JSON.parse(bytes);
    if (data.id !== undefined && data.method?.endsWith("/requestApproval"))
      nativeApprovals.push(data.method);
    log({ direction: "response", data });
    if (client.readyState === WebSocket.OPEN) client.send(bytes.toString());
  });
  upstream.on("error", () => client.close());
  upstream.on("close", () => client.close());
  client.on("close", () => upstream.close());
});
const upstreamUrl = "ws://127.0.0.1:" + proxy.address().port + "/";
const config = readConfig({
  CODEX_HOME: codexHome,
  CLAUDE_CONFIG_DIR: join(dir, "claude"),
  CLAUDEX_WEB_CONFIG_DIR: join(dir, "web"),
  CODEX_APP_SERVER_URL: upstreamUrl,
});
const backend = (await createBackendConfiguration(config).read()).backends[0];
const background = createBackgroundService(config);
const storage = createStorage(nativeDelegationStatePath(config.configDir), {
  tasks: {},
  notices: {},
  receipts: {},
});
const store = {
  ...storage,
  async change(update) {
    let value;
    await storage.update((state) => {
      value = update(state);
      return state;
    });
    return value;
  },
};
const delivered = new Map();
const version = { displayVersion: "research-fixture" };
const runtime = createDelegationRuntime({
  store,
  config,
  version,
  emit() {},
  async deliver(notice) {
    delivered.set(notice.taskId, notice.payload);
    await store.change((state) => {
      state.notices[notice.id].status = "delivered";
    });
  },
});

const pending = new Map();
const web = createCodexAdapter({
  config,
  backend,
  version,
  background,
  backgroundEnabled: () => background.listening(),
  broadcast() {},
  send(_client, message) {
    const { resolve, reject } = pending.get(message.id) || {};
    if (message.error) reject?.(new Error(message.error.message));
    else resolve?.(message.result);
  },
});
const browser = { readyState: 1 };
async function webRpc(method, params) {
  const id = randomUUID();
  const response = Promise.withResolvers();
  pending.set(id, response);
  try {
    await web.receive(browser, {
      id,
      method,
      params: fullAccessParams(method, params),
    });
    return await response.promise;
  } finally {
    pending.delete(id);
  }
}

async function until(label, read) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(75);
  }
  throw new Error("验证超时 " + label);
}
function command(cmd) {
  return {
    type: "function_call",
    name: "exec_command",
    call_id: randomUUID(),
    arguments: JSON.stringify({ cmd, workdir: cwd, yield_time_ms: 1000 }),
  };
}
const text = (text) => [{ type: "text", text }];
const probe = (name) =>
  `cat input.txt; touch ${name}.txt; echo cwd_write=$?; touch ${join(dir, name + ".txt")}; echo tmp_write=$?; curl --noproxy '*' -fsS --connect-timeout 1 ${base}/probe; echo net=$?`;
const patch =
  "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: patch.txt\n+fixture\n*** End Patch\nPATCH";
const readOnly = { type: "readOnly", networkAccess: false };
const fullAccess = { type: "dangerFullAccess" };
const taskHealth = () =>
  taskRequest(background.directory, "health", {
    expectedUpstream: upstreamUrl,
  });
let raw;
async function delegate(scope, executor) {
  const id = randomUUID();
  await store.change((state) => {
    state.tasks[id] = {
      id,
      parentId: "fixture-parent",
      parentTurnId: "parent-turn",
      target: "codex",
      scope,
      cwd,
      selection: { model: "gpt-5.4", effort: "low" },
      status: "accepted",
      ...(executor && {
        executor: { threadId: executor, runtimeId: runtimeIdentity(backend) },
      }),
      steps: [
        {
          id: randomUUID(),
          request: phase,
          acceptedAt: Date.now(),
          parentTurnId: "parent-turn",
        },
      ],
    };
  });
  runtime.wake();
  return id;
}
async function result(id) {
  await until("委派结果回投 " + phase, () => delivered.get(id));
  const task = (await store.read()).tasks[id];
  assert.equal(
    task.status,
    "completed",
    JSON.stringify(task.steps.at(-1).result),
  );
  return task;
}
function nativeRequest(method, filter) {
  return wire
    .filter((entry) => entry.method === method && filter(entry.params))
    .at(-1)?.params;
}
function assertTurn(threadId, sandboxPolicy) {
  const request = nativeRequest(
    "turn/start",
    (params) => params.threadId === threadId,
  );
  assert.deepEqual(request.sandboxPolicy, sandboxPolicy);
  assert.equal(request.approvalPolicy, "never");
  assert.equal("sandbox" in request || "permissions" in request, false);
  return request;
}
function toolOutput(name) {
  return modelCalls
    .filter((call) => call.phase === name)
    .flatMap(({ outputs }) => outputs.map(({ output }) => output))
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join("\n");
}
function assertReadOnly(name) {
  const output = toolOutput(name);
  assert.match(output, /READ_OK/);
  assert.match(output, /cwd_write=1/);
  assert.match(output, /tmp_write=1/);
  assert.match(output, /net=7/);
  for (const path of [join(cwd, name + ".txt"), join(dir, name + ".txt")])
    assert.equal(existsSync(path), false);
  console.log(name, "READ_OK · cwd_write=1 · tmp_write=1 · net=7");
}

try {
  await until("原生 Codex 启动", async () => {
    try {
      raw = await connectCodex(upstreamUrl);
      return raw;
    } catch {
      return null;
    }
  });
  await web.connect();
  phase = "RESEARCH";
  replies = [
    command(probe(phase)),
    command(patch),
    command(
      "printf 'NATIVE_STARTED\\n'; sleep 6; cat input.txt; touch long.txt; test ! -e long.txt && printf 'NATIVE_DONE\\n'",
    ),
  ];
  const id = await delegate("research");
  const running = await until("研究线程已就绪", async () => {
    const task = (await store.read()).tasks[id];
    return task.status === "running" && task;
  });
  const researchThread = running.executor.threadId;
  await until("后台服务接管原生长命令", async () => {
    if (!background.listening()) return null;
    const { jobs } = await taskRequest(background.directory, "tool", {
      name: "background_list",
      args: {},
      threadId: researchThread,
    });
    return jobs.find(({ native, status }) => native && status === "running");
  });
  assert.equal(delivered.has(id), false);
  console.log("原生长命令跨轮运行，委派等待完成回执");
  const research = await result(id);
  assertReadOnly("RESEARCH");
  assert.match(
    toolOutput("RESEARCH"),
    /patch rejected: writing is blocked by read-only sandbox/,
  );
  assert.equal(existsSync(join(cwd, "patch.txt")), false);
  assert.equal(existsSync(join(cwd, "long.txt")), false);
  assert.match(toolOutput("RESEARCH"), /NATIVE_DONE/);
  assert.match(toolOutput("RESEARCH"), /long\.txt.*Read-only file system/);
  assert.equal(research.steps[0].result.turns.length, 2);
  assert.match(delivered.get(id).answer, /派单轮答复[\s\S]+后台终端完成/);
  assert.equal(
    modelCalls
      .filter(({ phase }) => phase === "RESEARCH")
      .some(({ tools }) =>
        tools.some((name) => /claudex_background|background_start/.test(name)),
      ),
    false,
  );
  const started = nativeRequest(
    "thread/start",
    ({ cwd: path }) => path === cwd,
  );
  assert.equal(started.sandbox, "read-only");
  assert.equal(started.approvalPolicy, "never");
  assert.equal(started.config["mcp_servers.claudex_background"].enabled, false);
  assertTurn(researchThread, readOnly);
  const wake = nativeRequest(
    "turn/start",
    ({ threadId, turnTrigger }) =>
      threadId === researchThread && turnTrigger === "background_task",
  );
  assert(wake);
  assert.deepEqual(wake.sandboxPolicy, readOnly);
  assert.equal(wake.approvalPolicy, "never");
  assert.equal(JSON.parse(wake.toolOutput.output).results[0].exit_code, 0);
  assert.match(JSON.stringify(wake.toolOutput), /NATIVE_DONE/);
  console.log("apply_patch rejected: writing is blocked by read-only sandbox");
  console.log(
    "原生长命令退出 0，真实输出 NATIVE_DONE，研究续跑和委派回投共 2 轮",
  );

  const resume = await webRpc("thread/resume", {
    threadId: researchThread,
    config: { "mcp_servers.claudex_background.enabled": true },
  });
  assert.deepEqual(resume.sandbox, readOnly);
  const resumed = nativeRequest(
    "thread/resume",
    ({ threadId }) => threadId === researchThread,
  );
  assert.equal(resumed.sandbox, "read-only");
  assert.equal(resumed.approvalPolicy, "never");
  assert.equal(resumed.config["mcp_servers.claudex_background"].enabled, false);
  for (const method of [
    "turn/start",
    "command/exec",
    "thread/settings/update",
    "thread/fork",
    "thread/shellCommand",
  ]) {
    await assert.rejects(
      webRpc(method, { threadId: researchThread }),
      /只读执行/,
    );
  }
  await assert.rejects(
    webRpc("turn/start", { threadId: researchThread.toUpperCase() }),
    /只读执行/,
  );
  await assert.rejects(
    webRpc("thread/resume", {
      threadId: researchThread,
      path: resume.thread.path,
    }),
    /会话 ID/,
  );
  console.log("网页全权恢复归一为 readOnly；执行、设置、分叉和 shell 请求被拒");

  phase = "LEGACY_SEED";
  const legacy = await raw.call("thread/start", {
    cwd,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    config: mcpConfig(background.directory, upstreamUrl),
  });
  assert.deepEqual(legacy.sandbox, fullAccess);
  const legacyId = legacy.thread.id;
  const seed = await raw.call("turn/start", {
    threadId: legacyId,
    input: text(phase),
  });
  await until("旧会话落盘", async () => {
    const { thread } = await raw.call("thread/read", {
      threadId: legacyId,
      includeTurns: true,
    });
    return thread.turns.find(
      ({ id, status }) => id === seed.turn.id && status === "completed",
    );
  });
  await store.change(({ tasks }) => {
    tasks.legacy = {
      id: "legacy",
      scope: "research",
      target: "codex",
      status: "completed",
      executor: { threadId: legacyId, runtimeId: runtimeIdentity(backend) },
      steps: [],
    };
  });
  await assert.rejects(
    taskRequest(background.directory, "tool", {
      name: "background_start",
      threadId: legacyId,
      expectedUpstream: upstreamUrl,
      args: {
        command: "touch host-write.txt",
        title: "host check",
        check_after_ms: 60000,
      },
    }),
    ({ message }) => {
      assert.match(message, /Codex 研究委派只允许原生只读命令/);
      console.log("后台任务服务实际错误", message);
      return true;
    },
  );
  assert.equal(existsSync(join(cwd, "host-write.txt")), false);
  console.log("任务服务拒绝仍以 dangerFullAccess 加载的旧研究线程启动后台终端");

  await raw.call("thread/unsubscribe", { threadId: legacyId });
  await until(
    "旧研究会话卸载",
    async () =>
      !(await raw.call("thread/loaded/list", {})).data.includes(legacyId),
  );
  phase = "LEGACY";
  replies = [command(probe(phase))];
  await result(await delegate("research", legacyId));
  assert.equal(
    nativeRequest("thread/resume", ({ threadId }) => threadId === legacyId)
      .sandbox,
    "read-only",
  );
  assertTurn(legacyId, readOnly);
  assertReadOnly("LEGACY");
  assert.equal(
    modelCalls
      .filter(({ phase }) => phase === "LEGACY")
      .some(({ tools }) =>
        tools.some((name) => name.includes("claudex_background")),
      ),
    false,
  );

  phase = "IMPLEMENTATION";
  replies = [
    command(
      "printf WRITE_OK > implementation.txt; node --test fixture.test.cjs; curl --noproxy '*' -fsS " +
        base +
        "/probe",
    ),
  ];
  const implementation = await result(await delegate("implementation"));
  const implementationStart = nativeRequest(
    "thread/start",
    ({ cwd: path }) => path === cwd,
  );
  assert.equal(implementationStart.sandbox, "danger-full-access");
  assert.equal(implementationStart.approvalPolicy, "never");
  assertTurn(implementation.executor.threadId, fullAccess);
  assert.equal(
    readFileSync(join(cwd, "implementation.txt"), "utf8"),
    "WRITE_OK",
  );
  assert.match(toolOutput(phase), /tests 1[\s\S]+pass 1[\s\S]+LOOPBACK_OK/);
  console.log("IMPLEMENTATION · WRITE_OK · tests 1 / pass 1 · LOOPBACK_OK");

  phase = "WEB";
  replies = [command("printf WEB_WRITE_OK > web.txt")];
  const ordinary = await webRpc("thread/start", { cwd });
  assert.deepEqual(ordinary.sandbox, fullAccess);
  const turn = await webRpc("turn/start", {
    threadId: ordinary.thread.id,
    input: text(phase),
  });
  await until("普通网页轮", async () => {
    const { thread } = await raw.call("thread/read", {
      threadId: ordinary.thread.id,
      includeTurns: true,
    });
    return thread.turns.find(
      ({ id, status }) => id === turn.turn.id && status === "completed",
    );
  });
  assertTurn(ordinary.thread.id, fullAccess);
  assert.equal(readFileSync(join(cwd, "web.txt"), "utf8"), "WEB_WRITE_OK");
  const ordinaryResume = await webRpc("thread/resume", {
    threadId: ordinary.thread.id,
  });
  assert.deepEqual(ordinaryResume.sandbox, fullAccess);
  const standalone = await webRpc("command/exec", {
    command: ["sh", "-c", "printf STANDALONE_OK > standalone.txt"],
    cwd,
  });
  assert.equal(standalone.exitCode, 0);
  assert.equal(
    readFileSync(join(cwd, "standalone.txt"), "utf8"),
    "STANDALONE_OK",
  );
  assert.deepEqual(nativeApprovals, []);
  assert(
    modelCalls
      .filter(({ phase }) => phase === "WEB")
      .some(({ tools }) =>
        tools.some((name) => name.includes("claudex_background")),
      ),
  );
  console.log("普通网页会话 · dangerFullAccess · WEB_WRITE_OK · STANDALONE_OK");
  console.log("PASS Codex 委派只读沙箱和原生后台结算");
} finally {
  runtime.close();
  web.close();
  raw?.close();
  if (background.listening()) {
    const { pid } = await taskHealth().catch(() => ({}));
    if (pid) process.kill(pid, "SIGTERM");
  }
  for (const client of proxy.clients) client.terminate();
  await new Promise((resolve) => proxy.close(resolve));
  native.kill();
  model.closeAllConnections();
  model.close();
}

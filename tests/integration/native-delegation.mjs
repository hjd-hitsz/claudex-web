import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBackendConfiguration } from "../../server/src/backends/configuration.mjs";
import { createBackendManager } from "../../server/src/backends/manager.mjs";
import { createConversationManager } from "../../server/src/conversation-manager/manager.mjs";
import { messagesServer } from "../helpers/claude-messages-server.mjs";
import { shutdownBrowserClaudeWorker } from "../helpers/claude-worker-cleanup.mjs";

const root = await mkdtemp(join(tmpdir(), "claudex-native-delegation-"));
const cwd = join(root, "workspace");
const codexHome = join(root, "codex");
const claudeHome = join(root, "claude");
const bin = join(root, "bin");
await Promise.all([cwd, codexHome, claudeHome, bin].map((path) => mkdir(path)));
await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const environment = { ...process.env };
process.env.PATH = bin + ":" + process.env.PATH;
process.env.XDG_RUNTIME_DIR = root;
delete process.env.ANTHROPIC_AUTH_TOKEN;
process.env.ANTHROPIC_API_KEY = "fixture";
const tokenPattern = /token \\?"([a-f0-9-]{36})/;
const toolName = "mcp__claudex_conversation__delegate_task";
const stepTool = "read_delegation_step";
const claudeStepTool = "mcp__claudex_conversation__" + stepTool;
const codexModel = "gpt-5.4";
const claudeModel = "claude-sonnet-4-6";
const codexPrompt = "CODEX_PRESET_PROOF";
const claudePrompt = "CLAUDE_PRESET_PROOF";
const proof = { codex: {}, claude: {} };
const source = { codex: "CODEX_SOURCE_PROOF", claude: "CLAUDE_SOURCE_PROOF" };
const requestArguments = (token, origin) => ({
  token,
  request: "Return the fixture evidence for " + origin,
  request_id: "native-" + origin,
  scope: "implementation",
});
function lookupInput(messages) {
  const text = messages
    .flatMap(({ content, output }) => {
      const parts = content ?? output;
      return typeof parts === "string"
        ? [parts]
        : parts?.map(({ text }) => text) || [];
    })
    .find((text) => text?.startsWith("Claudex 委派执行结果"));
  const { task_id: taskId, stepId } = JSON.parse(text.split("\n").at(-1));
  return { taskId, stepId };
}

let number = 0;
const codex = createServer(async (request, response) => {
  if (request.url !== "/v1/responses") return response.writeHead(404).end();
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  const prompt = JSON.stringify(body.input);
  const index = ++number;
  const id = "fixture-" + index;
  const tools = body.tools.flatMap(
    (entry) =>
      entry.tools?.map((child) => ({ ...child, namespace: entry.name })) || [
        entry,
      ],
  );
  let answer = "CODEX_ACCEPTED_PROOF";
  let call;
  if (body.text?.format?.type === "json_schema")
    answer = '{"title":"Delegation proof"}';
  else if (prompt.includes("Claudex 委派执行结果")) {
    proof.codex.result = prompt.includes("CLAUDE_EXECUTOR_PROOF");
    const returned = body.input.find(
      ({ type, call_id }) =>
        type === "function_call_output" && call_id === "read-codex-step",
    );
    if (!returned) {
      const tool = tools.find(({ name }) => name === stepTool);
      assert(tool, "Codex 回投轮次应提供详情工具");
      call = {
        type: "function_call",
        name: tool.name,
        namespace: tool.namespace,
        call_id: "read-codex-step",
        arguments: JSON.stringify(lookupInput(body.input)),
      };
    } else {
      const output = JSON.stringify(returned.output);
      proof.codex.lookupOutput = output;
      proof.codex.lookup =
        output.includes("callChain") &&
        output.includes("CLAUDE_EXECUTOR_PROOF");
      answer = "CODEX_RETURNED_PROOF";
    }
  } else if (prompt.includes("[Claudex delegation step:")) {
    proof.codex.executor = {
      model: body.model,
      effort: body.reasoning?.effort,
      containsSourcePrompt:
        prompt.includes(codexPrompt) || prompt.includes(claudePrompt),
    };
    answer = "CODEX_EXECUTOR_PROOF";
  } else if (prompt.includes(source.codex)) {
    const tool = tools.find(({ name }) => name === "delegate_task");
    const token = tokenPattern.exec(prompt)?.[1];
    if (!prompt.includes("native-codex") && tool && token) {
      proof.codex.source =
        prompt.includes(codexPrompt) && !prompt.includes(claudePrompt);
      call = {
        type: "function_call",
        name: tool.name,
        namespace: tool.namespace,
        call_id: "delegate-fixture-" + index,
        arguments: JSON.stringify(requestArguments(token, "codex")),
      };
    }
  }
  const item = call || {
    id: "message-" + index,
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: answer }],
  };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    [
      { type: "response.created", response: { id } },
      { type: "response.output_item.done", item },
      {
        type: "response.completed",
        response: {
          id,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ]
      .map(
        (event) =>
          "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n",
      )
      .join(""),
  );
});
codex.listen(0, "127.0.0.1");
await once(codex, "listening");

const claude = await messagesServer((body) => {
  const prompt = JSON.stringify(body.messages);
  const context = JSON.stringify(body);
  const tool = body.tools?.find(({ name }) => name === toolName);
  if (prompt.includes("Claudex 委派执行结果")) {
    if (!body.tools?.length)
      return [{ type: "text", text: "Delegation proof" }];
    proof.claude.result = prompt.includes("CODEX_EXECUTOR_PROOF");
    const returned = body.messages
      .flatMap(({ content }) => (Array.isArray(content) ? content : []))
      .find(
        ({ type, tool_use_id }) =>
          type === "tool_result" && tool_use_id === "toolu_read_claude_step",
      );
    if (!returned) {
      assert(
        body.tools.some(({ name }) => name === claudeStepTool),
        "Claude Code 回投轮次应提供详情工具 " +
          JSON.stringify(
            body.tools.map(({ name, defer_loading }) => [name, defer_loading]),
          ),
      );
      return [
        {
          type: "tool_use",
          id: "toolu_read_claude_step",
          name: claudeStepTool,
          input: lookupInput(body.messages),
        },
      ];
    }
    const output = JSON.stringify(returned.content);
    proof.claude.lookupOutput = output;
    proof.claude.lookup =
      output.includes("callChain") && output.includes("CODEX_EXECUTOR_PROOF");
    return [{ type: "text", text: "CLAUDE_RETURNED_PROOF" }];
  }
  if (prompt.includes("[Claudex delegation step:")) {
    proof.claude.executor = {
      model: body.model,
      effort: body.output_config?.effort,
      containsSourcePrompt:
        prompt.includes(codexPrompt) || prompt.includes(claudePrompt),
    };
    return [{ type: "text", text: "CLAUDE_EXECUTOR_PROOF" }];
  }
  const token = tokenPattern.exec(context)?.[1];
  if (
    prompt.includes(source.claude) &&
    !prompt.includes("native-claude") &&
    token
  ) {
    proof.claude.firstRequestTool = Boolean(
      tool &&
      !tool.defer_loading &&
      JSON.stringify([body.system, body.messages]).includes(toolName),
    );
    proof.claude.source =
      context.includes(claudePrompt) && !context.includes(codexPrompt);
    return [
      {
        type: "tool_use",
        id: "toolu_delegate_fixture",
        name: toolName,
        input: requestArguments(token, "claude"),
      },
    ];
  }
  return [{ type: "text", text: "CLAUDE_ACCEPTED_PROOF" }];
});
process.env.ANTHROPIC_BASE_URL = claude.url;

const reserve = createServer();
reserve.listen(0, "127.0.0.1");
await once(reserve, "listening");
const upstreamUrl = "ws://127.0.0.1:" + reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
await writeFile(
  join(codexHome, "config.toml"),
  [
    'model = "' + codexModel + '"',
    'model_provider = "fixture"',
    'approval_policy = "never"',
    "[model_providers.fixture]",
    'name = "fixture"',
    'base_url = "http://127.0.0.1:' + codex.address().port + '/v1"',
    'wire_api = "responses"',
  ].join("\n"),
);
const config = {
  configDir: root,
  backendsFile: join(root, "backends.json"),
  codexHome,
  claudeHome,
  defaultCwd: cwd,
  projectlessRoot: join(root, "projects"),
  upstreamUrl,
};
const native = spawn("codex", ["app-server", "--listen", upstreamUrl], {
  env: { ...process.env, CODEX_HOME: codexHome },
  cwd,
  stdio: ["ignore", "ignore", "pipe"],
});
let errors = "";
native.stderr.on("data", (chunk) => {
  errors = (errors + chunk).slice(-5000);
});
const configuration = createBackendConfiguration(config);
await configuration.save({ id: "claude", type: "claude", enabled: true });
const events = [];
const replies = new Map();
let manager;
let conversations;
async function start() {
  conversations = createConversationManager({ configDir: root });
  await conversations.start();
  manager = createBackendManager({
    config,
    conversations,
    version: { displayVersion: "fixture" },
    send: (_client, message) => replies.get(message.id)?.(message),
    broadcast: (message) => events.push(message),
    factories: { installation: { state: () => ({}) } },
  });
  await manager.connect();
  await until(
    () =>
      manager
        .state()
        .params.backends.filter(({ id }) => id !== "agy")
        .every(({ ready }) => ready),
    "双后端连接",
  );
}
async function until(read, title) {
  for (const end = Date.now() + 35000; Date.now() < end;) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error("验证超时：" + title);
}
const client = { readyState: 1 };
async function rpc(method, params = {}) {
  const id = randomUUID();
  const response = Promise.withResolvers();
  replies.set(id, response.resolve);
  try {
    await manager.receive(client, { id, method, params });
    const reply = await response.promise;
    if (reply.error) throw new Error(reply.error.message);
    return reply.result;
  } finally {
    replies.delete(id);
  }
}
const prompts = [
  { id: "codex-proof", name: "Codex 执行", content: codexPrompt },
  { id: "claude-proof", name: "Claude 执行", content: claudePrompt },
];
const delegates = {
  codex: { model: codexModel, effort: "low", enabled: true },
  claude: { model: claudeModel, effort: "medium", enabled: true },
};
const threads = {};
try {
  await start();
  const providerId = "delegation-messages-fixture";
  await rpc("lan/providers/save", {
    id: providerId,
    backendId: "claude",
    name: "Messages fixture",
    baseUrl: claude.url,
    apiKey: "fixture",
    models: [claudeModel],
    protocol: "messages",
  });
  await rpc("lan/backends/save", {
    id: "agy",
    type: "agy",
    delegates,
    delegationPrompts: prompts,
    delegationSourcePrompts: { codex: prompts[0].id, claude: prompts[1].id },
  });
  assert.deepEqual(
    (await configuration.read()).backends.find(({ id }) => id === "agy")
      .delegationPrompts,
    prompts,
  );

  const { thread: blocked } = await rpc("thread/start", {
    backendId: "codex",
    cwd,
    model: codexModel,
  });
  await rpc("lan/backends/save", {
    id: "agy",
    type: "agy",
    delegates: {
      ...delegates,
      claude: { ...delegates.claude, enabled: false },
    },
  });
  await assert.rejects(
    rpc("turn/start", {
      threadId: blocked.id,
      delegationMode: true,
      input: [{ type: "text", text: "关闭接收时拒绝新委派" }],
    }),
    /开启接收委派/,
  );
  await rpc("lan/backends/save", { id: "agy", type: "agy", delegates });

  for (const [origin, model] of [
    ["codex", codexModel],
    ["claude", claudeModel],
  ]) {
    const provider = origin === "claude" ? { providerId } : {};
    const { thread } = await rpc("thread/start", {
      backendId: origin,
      cwd,
      model,
      ...provider,
    });
    threads[origin] = thread.id;
    await rpc("turn/start", {
      threadId: thread.id,
      model,
      ...provider,
      delegationMode: true,
      input: [{ type: "text", text: source[origin] }],
    });
    await until(() => proof[origin].result, origin + " 收到委派执行结果");
    await until(
      () =>
        events.some(
          (event) =>
            event.method === "item/completed" &&
            event.params.threadId === thread.id &&
            event.params.item?.type === "agentMessage" &&
            event.params.item.text?.includes(
              origin.toUpperCase() + "_RETURNED_PROOF",
            ),
        ),
      origin + " 发起端完成结果回复",
    );
    assert.equal(
      proof[origin].lookup,
      true,
      origin +
        " 按 taskId 与 stepId 读取回投结果 " +
        proof[origin].lookupOutput,
    );
    const { items } = await rpc("lan/delegation/tasks", {
      threadId: thread.id,
    });
    assert.equal(items.length, 1);
    const agent = items[0];
    assert.equal(agent.agentStatus, "completed");
    const { thread: detail } = await rpc("thread/read", {
      threadId: agent.agentThreadId,
      includeTurns: true,
    });
    assert(
      detail.turns.some(({ items }) =>
        items.some(({ text }) => text?.includes("_EXECUTOR_PROOF")),
      ),
    );
    assert.equal(detail.id, agent.agentThreadId);
  }
  await until(async () => {
    const state = JSON.parse(
      await readFile(join(root, "delegation", "state.json"), "utf8"),
    );
    return (
      Object.values(state.notices).every(
        ({ status }) => status === "delivered",
      ) && !Object.keys(manager.state().params.activeTurns).length
    );
  }, "双向结果完成投递与原生回执核对");
  assert.deepEqual(proof.codex.executor, {
    model: codexModel,
    effort: "low",
    containsSourcePrompt: false,
  });
  assert.deepEqual(proof.claude.executor, {
    model: claudeModel,
    effort: "medium",
    containsSourcePrompt: false,
  });
  assert.equal(proof.codex.source, true);
  assert.equal(proof.claude.source, true);
  assert.equal(proof.claude.firstRequestTool, true);
  await manager.close();
  await conversations.close();
  await start();
  for (const threadId of Object.values(threads)) {
    const { items } = await rpc("lan/delegation/tasks", { threadId });
    assert.equal(items[0].agentStatus, "completed");
  }
  const saved = (await rpc("lan/backends/list")).backends.find(
    ({ id }) => id === "agy",
  );
  assert.deepEqual(saved.delegationPrompts, prompts);
  assert.equal(saved.delegationSourcePrompts.claude, prompts[1].id);
  assert.equal(saved.delegationSourcePrompts.codex, prompts[0].id);
  console.log(
    "Codex → Claude Code 和 Claude Code → Codex 原生 MCP 双向委派及步骤查询通过",
  );
  console.log(
    "发起端各自提示词、执行端模型与强度、结果回投、原生历史与桥接重启恢复通过",
  );
} catch (error) {
  console.error({
    proof,
    errors,
    recent: events.slice(-25).map(({ method, params }) => ({
      method,
      status: params?.turn?.status,
      error: params?.turn?.error,
      tool: params?.item?.type === "mcpToolCall" && {
        result: params.item.result,
        error: params.item.error,
      },
    })),
  });
  throw error;
} finally {
  for (const [threadId, turnId] of Object.entries(
    manager?.state().params.activeTurns || {},
  ))
    await rpc("turn/interrupt", { threadId, turnId }).catch(() => {});
  await manager?.close();
  await conversations?.close();
  try {
    await shutdownBrowserClaudeWorker(config);
  } catch (error) {
    if (error.code !== "EWORKERBUSY") throw error;
    await delay(1000);
    await shutdownBrowserClaudeWorker(config);
  }
  if (native.exitCode === null) {
    native.kill();
    await once(native, "exit");
  }
  codex.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => codex.close(resolve)),
    claude.close(),
  ]);
  process.env = environment;
  await rm(root, { recursive: true, force: true });
}

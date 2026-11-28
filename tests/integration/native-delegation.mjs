import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resourceTarget } from "../../shared/backend-identity.mjs";
import { createDelegationModes } from "../../server/src/backends/delegation/source-modes.mjs";
import { resolveNativeSecretaryRole } from "../../server/src/backends/delegation/settings.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { createBackendConfiguration } from "../../server/src/backends/configuration.mjs";
import { createBackendManager } from "../../server/src/backends/manager.mjs";
import { createConversationManager } from "../../server/src/conversation-manager/manager.mjs";
import { createDelegationActivity } from "../../server/src/backends/delegation/activity.mjs";
import { messagesServer } from "../helpers/claude-messages-server.mjs";
import { shutdownBrowserClaudeWorker } from "../helpers/claude-worker-cleanup.mjs";

const root = await mkdtemp(join(tmpdir(), "claudex-native-delegation-"));
const cwd = join(root, "workspace");
await mkdir(cwd);
await writeFile(join(cwd, "fixture.txt"), "Local file fixture\n");
await writeFile(join(cwd, "CLAUDE.md"), "# CLAUDE_PROJECT_RULE_PROOF\n");
const directProjectRule = "PROJECT_IMPLEMENTATION_OWNER_PROOF";
const projectScope = "工作分工由会话当前的系统角色和用户选择决定";
await writeFile(
  join(cwd, "AGENTS.md"),
  `# ${directProjectRule}\n\nImplement engineering requests directly and run their checks.\n`,
);
const codexHome = join(root, "codex");
const claudeHome = join(root, "claude");
const bin = join(root, "bin");
await Promise.all([codexHome, claudeHome, bin].map((path) => mkdir(path)));
await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const environment = { ...process.env };
process.env.PATH = bin + ":" + process.env.PATH;
process.env.XDG_RUNTIME_DIR = root;
delete process.env.ANTHROPIC_AUTH_TOKEN;
process.env.ANTHROPIC_API_KEY = "fixture";
const toolName = "mcp__claudex_conversation__delegate_task";
const stepTool = "read_delegation_step";
const claudeStepTool = "mcp__claudex_conversation__" + stepTool;
const codexModel = "gpt-5.4";
const claudeModel = "gsq-rco-27b";
const claudeProtocol = process.argv.includes("--anthropic")
  ? "anthropic"
  : "messages";
const codexPrompt = "CODEX_PRESET_PROOF";
const longCodexRole =
  "Codex secretary instructions. ".repeat(110) + codexPrompt;
const claudePrompt = "CLAUDE_PRESET_PROOF";
const longClaudeRole =
  "Claude secretary instructions. ".repeat(110) + claudePrompt;
const proof = { codex: {}, claude: {} };
const executorGate = {
  codex: Promise.withResolvers(),
  claude: Promise.withResolvers(),
};
let expectedClaudeRole;
const source = { codex: "CODEX_SOURCE_PROOF", claude: "CLAUDE_SOURCE_PROOF" };
const requestArguments = (origin) => ({
  request: "Return the fixture evidence for " + origin,
  request_id: "native-" + origin,
  scope: "implementation",
});
const directPrompt = "SECRETARY_DIRECT_PROOF";
const localPrompt = "SECRETARY_LOCAL_TOOL_PROOF";
const standardPrompt = "STANDARD_ASSISTANT_PROOF";
const offPrompt = "DISABLED_SECRETARY_PROOF";
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
  const instructions = JSON.stringify([
    body.instructions,
    body.input.filter(({ role }) => role === "developer"),
  ]);
  const collaboration = body.input
    .filter(
      ({ role, content }) =>
        role === "developer" &&
        JSON.stringify(content).includes("<collaboration_mode>"),
    )
    .at(-1);
  let answer = "CODEX_ACCEPTED_PROOF";
  let call;
  if (body.text?.format?.type === "json_schema")
    answer = '{"title":"Delegation proof"}';
  else if (
    prompt.includes(offPrompt) ||
    (prompt.includes(standardPrompt) && !prompt.includes(directPrompt))
  ) {
    proof.codex[prompt.includes(offPrompt) ? "off" : "standard"] =
      !tools.some(({ name }) => name === "delegate_task") &&
      (prompt.includes(offPrompt)
        ? JSON.stringify(collaboration).includes(
            "You are now in Default mode",
          ) && !JSON.stringify(collaboration).includes(codexPrompt)
        : !instructions.includes(codexPrompt));
    answer = "CODEX_STANDARD_ANSWER";
  } else if (prompt.includes("Claudex 委派执行结果")) {
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
        output.includes("calls") && output.includes("nextOffset");
      answer = "CODEX_RETURNED_PROOF";
    }
  } else if (prompt.includes("[Claudex delegation step:")) {
    await executorGate.codex.promise;
    proof.codex.executor = {
      model: body.model,
      effort: body.reasoning?.effort,
      containsSourcePrompt:
        prompt.includes(codexPrompt) || prompt.includes(claudePrompt),
    };
    answer = "CODEX_EXECUTOR_PROOF";
  } else if (prompt.includes(directPrompt) && !prompt.includes(source.codex)) {
    proof.codex.direct =
      JSON.stringify(collaboration).includes(longCodexRole) &&
      tools.some(({ name }) => name === "delegate_task") &&
      tools.some(({ name }) => name === "exec_command") &&
      !body.input.some(
        ({ role, content }) =>
          role === "user" && JSON.stringify(content).includes(codexPrompt),
      );
    answer = "CODEX_DIRECT_ANSWER";
  } else if (
    prompt.includes(source.codex) &&
    !prompt.includes("delegate-retry-codex")
  ) {
    const tool = tools.find(({ name }) => name === "delegate_task");
    assert(tool);
    assert.equal("token" in tool.parameters.properties, false);
    proof.codex.source =
      instructions.includes(longCodexRole) &&
      !instructions.includes(claudePrompt);
    const retried = prompt.includes("delegate-first-codex");
    call = {
      type: "function_call",
      name: tool.name,
      namespace: tool.namespace,
      call_id: retried ? "delegate-retry-codex" : "delegate-first-codex",
      arguments: JSON.stringify(requestArguments("codex")),
    };
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

const claude = await messagesServer(async (body) => {
  const prompt = JSON.stringify(body.messages);
  const instructions = JSON.stringify(body.system);
  const tool = body.tools?.find(({ name }) => name === toolName);
  if (
    prompt.includes(offPrompt) ||
    (prompt.includes(standardPrompt) && !prompt.includes(directPrompt))
  ) {
    if (body.tools?.length)
      proof.claude[prompt.includes(offPrompt) ? "off" : "standard"] =
        !instructions.includes(claudePrompt) &&
        instructions.includes("You are an agent working with the user") &&
        !tool &&
        body.tools.some(({ name }) => name === "Bash");
    return [{ type: "text", text: "CLAUDE_STANDARD_ANSWER" }];
  }
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
      output.includes("calls") && output.includes("nextOffset");
    return [{ type: "text", text: "CLAUDE_RETURNED_PROOF" }];
  }
  if (prompt.includes("[Claudex delegation step:")) {
    await executorGate.claude.promise;
    proof.claude.executor = {
      model: body.model,
      effort: body.output_config?.effort,
      containsSourcePrompt:
        prompt.includes(codexPrompt) || prompt.includes(claudePrompt),
    };
    return [{ type: "text", text: "CLAUDE_EXECUTOR_PROOF" }];
  }
  if (prompt.lastIndexOf(localPrompt) > prompt.lastIndexOf(directPrompt)) {
    if (!body.tools?.length)
      return [{ type: "text", text: "Delegation proof" }];
    if (!prompt.includes("toolu_local_bash")) {
      return [
        {
          type: "tool_use",
          id: "toolu_local_bash",
          name: "Bash",
          input: { command: "touch secretary-shell-canary" },
        },
        {
          type: "tool_use",
          id: "toolu_local_write",
          name: "Write",
          input: {
            file_path: join(cwd, "secretary-write-canary"),
            content: "fixture",
          },
        },
      ];
    }
    const contents = body.messages.flatMap(({ content }) =>
      Array.isArray(content) ? content : [],
    );
    proof.claude.localExecution = [
      "toolu_local_bash",
      "toolu_local_write",
    ].every((id) =>
      contents.some(
        ({ type, tool_use_id, is_error }) =>
          type === "tool_result" && tool_use_id === id && !is_error,
      ),
    );
    return [{ type: "text", text: "CLAUDE_LOCAL_ANSWER" }];
  }
  if (prompt.includes(directPrompt) && !prompt.includes(source.claude)) {
    if (body.tools?.length) {
      const latestProjectSnapshot = body.system?.findLast(({ text }) =>
        text.includes("本轮有效 AGENTS 项目指令"),
      )?.text;
      proof.claude.direct =
        instructions.includes(longClaudeRole) &&
        !instructions.includes("You are an agent working with the user") &&
        !prompt.includes(claudePrompt) &&
        prompt.includes("CLAUDE_PROJECT_RULE_PROOF") &&
        latestProjectSnapshot?.includes(directProjectRule) &&
        latestProjectSnapshot.indexOf(projectScope) >
          latestProjectSnapshot.indexOf(directProjectRule);
      proof.claude.firstRequestTool = Boolean(tool && !tool.defer_loading);
      proof.claude.secretarySystem =
        body.system.length === 1 &&
        body.system[0].text.startsWith(expectedClaudeRole) &&
        !body.system[0].text.includes(
          "Available agent types for the Agent tool:",
        ) &&
        !body.system[0].text.includes(
          "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
        );
      proof.claude.nativeToolCatalog = ["Bash", "Write", "Edit", "Agent"].every(
        (name) => body.tools.some((entry) => entry.name === name),
      );
    }
    return [{ type: "text", text: "CLAUDE_DIRECT_ANSWER" }];
  }
  if (
    prompt.includes(source.claude) &&
    !prompt.includes("toolu_delegate_retry")
  ) {
    if (!body.tools?.length)
      return [{ type: "text", text: "Delegation proof" }];
    assert(tool);
    assert.equal("token" in tool.input_schema.properties, false);
    if (!prompt.includes("toolu_local_read_fixture")) {
      return [
        {
          type: "tool_use",
          id: "toolu_local_read_fixture",
          name: "Read",
          input: { file_path: join(cwd, "fixture.txt") },
        },
      ];
    }
    proof.claude.localToolAllowed = body.messages
      .flatMap(({ content }) => (Array.isArray(content) ? content : []))
      .some(
        ({ type, tool_use_id, is_error, content }) =>
          type === "tool_result" &&
          tool_use_id === "toolu_local_read_fixture" &&
          !is_error &&
          JSON.stringify(content).includes("Local file fixture"),
      );
    proof.claude.source =
      instructions.includes(longClaudeRole) &&
      !instructions.includes(codexPrompt) &&
      !prompt.includes(claudePrompt);
    return [
      {
        type: "tool_use",
        id: prompt.includes("toolu_delegate_first")
          ? "toolu_delegate_retry"
          : "toolu_delegate_first",
        name: toolName,
        input: requestArguments("claude"),
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
  conversations = createConversationManager({
    configDir: root,
    readRuntime: () => manager.state().params,
    readDelegations: createDelegationActivity(root, () => false),
  });
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
  { id: "codex-proof", name: "Codex 执行", content: longCodexRole },
  { id: "claude-proof", name: "Claude 执行", content: longClaudeRole },
];
const delegates = {
  codex: { model: codexModel, effort: "low", enabled: true },
  claude: { model: claudeModel, effort: "medium", enabled: true },
};
const threads = {};
const optedIn = new Map();
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
    modelCapabilities: {
      [claudeModel]: {
        contextWindow: 196608,
        supportedEffortLevels: ["medium"],
        supportsFastMode: false,
        supportsAdaptiveThinking: false,
      },
    },
    protocol: claudeProtocol,
  });
  await rpc("lan/backends/save", {
    id: "agy",
    type: "agy",
    delegates,
    delegationPrompts: prompts,
    delegationSourcePrompts: { codex: prompts[0].id, claude: prompts[1].id },
  });
  expectedClaudeRole = await resolveNativeSecretaryRole(
    await configuration.readDelegationSettings(),
    "claude",
  );
  assert.deepEqual(
    (await configuration.read()).backends.find(({ id }) => id === "agy")
      .delegationPrompts,
    prompts,
  );

  async function directTurn(origin, params, marker, delegationMode) {
    const { turn } = await rpc("turn/start", {
      ...params,
      ...(delegationMode !== undefined && { delegationMode }),
      input: [{ type: "text", text: marker }],
    });
    const completion = await until(
      () =>
        events.find(
          ({ method, params: event }) =>
            method === "turn/completed" &&
            event.threadId === params.threadId &&
            event.turn?.id === turn.id,
        ),
      origin + " 直接回答轮次正常结束",
    );
    assert.equal(
      completion.params.turn.status,
      "completed",
      JSON.stringify(completion.params.turn.error),
    );
  }
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
    const params = {
      threadId: thread.id,
      model,
      ...provider,
      collaborationMode: {
        mode: "default",
        settings: { model, reasoning_effort: null },
      },
    };
    await directTurn(origin, params, standardPrompt);
    assert.equal(proof[origin].standard, true);
    await rpc("lan/delegation/mode/set", {
      threadId: thread.id,
      delegationMode: true,
    });
    await directTurn(origin, params, directPrompt, false);
    assert.equal(proof[origin].direct, true);
    assert.deepEqual(
      (await rpc("lan/delegation/tasks", { threadId: thread.id })).items,
      [],
    );
    assert.equal(
      (
        await rpc("thread/resume", {
          threadId: thread.id,
          ...provider,
        })
      ).thread.delegationMode,
      true,
    );

    const { turn: delegationTurn } = await rpc("turn/start", {
      threadId: thread.id,
      model,
      ...provider,
      input: [{ type: "text", text: source[origin] }],
    });
    await until(
      () =>
        events.some(
          ({ method, params }) =>
            method === "turn/completed" && params.turn.id === delegationTurn.id,
        ),
      origin + " 完成派单轮次",
    );
    const activity = async () =>
      (await conversations.listActivity()).activities.find(
        ({ threadId }) => threadId === thread.id,
      );
    const waiting = await until(async () => {
      const observed = await activity();
      return observed?.delegating && !observed.generating && observed;
    }, origin + " 空闲主会话在专家执行期间持续活跃");
    assert.equal(waiting.status, "delegating");
    assert.equal(waiting.live, true);
    executorGate[origin === "codex" ? "claude" : "codex"].resolve();
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
    await until(
      async () => !(await activity())?.live,
      origin + " 回投完成后退出活动列表",
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
    await until(
      () => !manager.state().params.activeTurns[thread.id],
      origin + " 回投轮次结束",
    );
    await rpc("lan/delegation/mode/set", {
      threadId: thread.id,
      delegationMode: false,
    });
    await directTurn(origin, params, offPrompt, true);
    assert.equal(proof[origin].off, true);

    const { thread: fresh, delegationMode } = await rpc("thread/start", {
      backendId: origin,
      cwd,
      model,
      ...provider,
      delegationMode: true,
    });
    assert.equal(delegationMode, true);
    assert.equal(fresh.delegationMode, true);
    const { nativeId } = resourceTarget(fresh.id, origin);
    const backend = (await configuration.read()).backends.find(
      ({ id }) => id === origin,
    );
    assert.equal(
      await createDelegationModes(root).enabled(backend, nativeId),
      true,
    );
    if (origin === "claude") {
      const index = JSON.parse(
        await readFile(
          join(backend.stateDir, "claudex-web-index.json"),
          "utf8",
        ),
      );
      assert.equal(index.sessions[nativeId].delegationMode, true);
      assert.equal(index.sessions[nativeId].initialized, false);
    }
    const freshParams = { ...params, threadId: fresh.id };
    proof[origin].direct = undefined;
    await directTurn(origin, freshParams, directPrompt);
    assert.equal(proof[origin].direct, true);
    if (origin === "claude") {
      const index = JSON.parse(
        await readFile(
          join(backend.stateDir, "claudex-web-index.json"),
          "utf8",
        ),
      );
      assert(
        index.sessions[nativeId].agentsAvailable.includes("claudex-secretary"),
      );
    }
    optedIn.set(origin, freshParams);
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
  assert.equal(proof.claude.secretarySystem, true);
  assert.equal(proof.claude.nativeToolCatalog, true);
  await directTurn("claude", optedIn.get("claude"), localPrompt, true);
  assert.equal(proof.claude.localExecution, true);
  assert.equal(await readFile(join(cwd, "secretary-shell-canary"), "utf8"), "");
  assert.equal(
    await readFile(join(cwd, "secretary-write-canary"), "utf8"),
    "fixture",
  );
  assert.equal(proof.claude.localToolAllowed, true);
  const persisted = JSON.parse(
    await readFile(join(root, "delegation", "state.json"), "utf8"),
  );
  assert.equal(Object.values(persisted.tasks).length, 2);
  assert(
    Object.values(persisted.tasks).every(({ steps }) => steps.length === 1),
  );
  assert.equal(Object.keys(persisted.receipts).length, 4);
  await manager.close();
  await conversations.close();
  await start();
  for (const [origin, params] of optedIn) {
    proof[origin].direct = undefined;
    assert.equal(
      (await rpc("thread/resume", params)).thread.delegationMode,
      true,
    );
    await directTurn(origin, params, directPrompt);
    assert.equal(proof[origin].direct, true);
  }
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
  console.log("双向委派发起会话在派单轮次结束后持续活跃，结果回投结算后退出");
  console.log(
    "原生模型请求中的秘书角色、项目说明与常规工具通过核对，Claude Bash 和 Write 均可执行",
  );
  console.log(
    "同一会话默认关闭、开启、关闭及新会话首轮开启均已核对原生提示词与工具目录。无派单回答、请求去重和桥接恢复通过",
  );
} catch (error) {
  console.error({
    proof,
    workerLog: await readFile(
      join(root, "backends/claude/worker.log"),
      "utf8",
    ).catch(() => ""),
    errors,
    recent: events.slice(-25).map(({ method, params }) => ({
      method,
      status: params?.turn?.status,
      error: params?.turn?.error,
      tool:
        params?.item?.type === "mcpToolCall" &&
        JSON.stringify({
          result: params.item.result,
          error: params.item.error,
        }),
    })),
  });
  throw error;
} finally {
  for (const gate of Object.values(executorGate)) gate.resolve();
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

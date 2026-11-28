import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
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
const ancestor = join(root, "ancestor");
const workspace = join(ancestor, "workspace");
const cwd = join(workspace, "nested");
await mkdir(cwd, { recursive: true });
await writeFile(join(ancestor, ".fixture-root"), "");
await writeFile(join(cwd, "fixture.txt"), "Local file fixture\n");
const directProjectRule = "PROJECT_IMPLEMENTATION_OWNER_PROOF";
const claudeProjectRule = "CLAUDE_PROJECT_RULE_PROOF";
const claudeUserRule = "CLAUDE_USER_RULE_PROOF";
const codexUserRule = "CODEX_USER_RULE_PROOF";
const projectSettings = "PROJECT_SETTINGS_PROOF";
const projectHook = "PROJECT_HOOK_PROOF";
const codexProjectHook = "CODEX_PROJECT_HOOK_PROOF";
const codexUserHook = "CODEX_USER_HOOK_PROOF";
function codexHook(sentinel) {
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: sentinel,
    },
  });
  const command = "printf '%s\\n' '" + output + "'";
  return [
    "[[hooks.UserPromptSubmit]]",
    "[[hooks.UserPromptSubmit.hooks]]",
    'type = "command"',
    "command = " + JSON.stringify(command),
  ].join("\n");
}
const userHook = "USER_HOOK_PROOF";
const levels = [
  [ancestor, "ancestor", "AGENTS.md"],
  [workspace, "root", "AGENTS.override.md"],
  [cwd, "nested", "AGENTS.md"],
];
const agentRules = levels.map(([, level]) => directProjectRule + "_" + level);
const claudeRules = levels.map(([, level]) => claudeProjectRule + "_" + level);
for (const [index, [dir, , document]] of levels.entries()) {
  await writeFile(join(dir, document), agentRules[index] + "\n");
  await writeFile(join(dir, "CLAUDE.md"), claudeRules[index] + "\n");
  await writeFile(
    join(dir, "GEMINI.md"),
    "OTHER_BACKEND_PROOF_" + index + "\n",
  );
}
await mkdir(join(cwd, ".codex"));
await writeFile(
  join(cwd, ".codex", "config.toml"),
  'developer_instructions = "' +
    projectSettings +
    '"\n' +
    codexHook(codexProjectHook),
);
const submitHook = (sentinel) => ({
  hooks: {
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: `printf '%s\\n' '${JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: sentinel,
              },
            })}'`,
          },
        ],
      },
    ],
  },
});
await mkdir(join(cwd, ".claude"));
await writeFile(
  join(cwd, ".claude", "settings.json"),
  JSON.stringify(submitHook(projectHook)),
);
const codexHome = join(root, "codex");
const claudeHome = join(root, "claude");
const bin = join(root, "bin");
await Promise.all([codexHome, claudeHome, bin].map((path) => mkdir(path)));
await writeFile(join(codexHome, "AGENTS.md"), codexUserRule + "\n");
await writeFile(join(claudeHome, "CLAUDE.md"), claudeUserRule + "\n");
await writeFile(
  join(claudeHome, "settings.json"),
  JSON.stringify(submitHook(userHook)),
);
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
  scope: "research",
});
const scopePrompt = "DELEGATION_SCOPE_CONFLICT";
const scopeError =
  "委派续问失败：原任务范围为 research，本次请求范围为 implementation。请用 implementation 新建委派任务，或改用 research 续问。";
const followUpArguments = (task_id) => ({
  request: "修改测试内容",
  request_id: "scope-conflict",
  task_id,
  scope: "implementation",
});
const followUpTasks = {};
const scopeProof = {};
const directPrompt = "SECRETARY_DIRECT_PROOF";
const localPrompt = "SECRETARY_LOCAL_TOOL_PROOF";
const standardPrompt = "STANDARD_ASSISTANT_PROOF";
const offPrompt = "DISABLED_SECRETARY_PROOF";
const lifecycle = new Map();
const projectProof = (origin, turn, body) => {
  const encoded = JSON.stringify(body);
  const expected =
    origin === "codex"
      ? [...agentRules, projectSettings, codexProjectHook]
      : [...agentRules, ...claudeRules, projectHook];
  const hits = expected.filter((sentinel) => encoded.includes(sentinel));
  const user = (
    origin === "codex"
      ? [codexUserRule, codexUserHook]
      : [claudeUserRule, userHook]
  ).every((sentinel) => encoded.includes(sentinel));
  const result = {
    backend: origin,
    turn,
    hits,
    expected,
    user,
    conversation:
      encoded.includes(standardPrompt) &&
      encoded.includes(
        origin === "claude"
          ? "CLAUDE_STANDARD_ANSWER"
          : "CODEX_STANDARD_ANSWER",
      ),
  };
  const key = origin + ":" + turn;
  if (lifecycle.has(key)) return;
  console.log(JSON.stringify(result));
  lifecycle.set(key, result);
};
function recordContext(origin, prompt, body) {
  if (prompt.includes("[Claudex delegation step:"))
    projectProof(origin, "EXPERT_DELEGATION", body);
  const turn = prompt.match(/CONTEXT_PROBE_[A-Z_]+/g)?.at(-1);
  if (turn) projectProof(origin, turn, body);
}
const scopeProbe = (prompt) =>
  prompt.lastIndexOf(scopePrompt) >
  Math.max(
    prompt.lastIndexOf(offPrompt),
    prompt.lastIndexOf(localPrompt),
    prompt.lastIndexOf(directPrompt),
  );
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
  if (body.text?.format?.type !== "json_schema")
    recordContext("codex", prompt, body);
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
  else if (scopeProbe(prompt)) {
    const returned = body.input.find(
      ({ type, call_id }) =>
        type === "function_call_output" && call_id === "scope-codex",
    );
    if (returned) scopeProof.codex = returned.output;
    else {
      const tool = tools.find(({ name }) => name === "delegate_task");
      assert(tool);
      call = {
        type: "function_call",
        name: tool.name,
        namespace: tool.namespace,
        call_id: "scope-codex",
        arguments: JSON.stringify(followUpArguments(followUpTasks.codex)),
      };
    }
  } else if (
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
  if (body.tools?.length) recordContext("claude", prompt, body);
  if (scopeProbe(prompt)) {
    if (!tool) return [{ type: "text", text: "Delegation proof" }];
    const returned = body.messages
      .flatMap(({ content }) => (Array.isArray(content) ? content : []))
      .find(({ tool_use_id }) => tool_use_id === "toolu_scope_claude");
    if (returned) {
      scopeProof.claude = returned;
      return [{ type: "text", text: "SCOPE_CONFLICT_PROOF" }];
    }
    return [
      {
        type: "tool_use",
        id: "toolu_scope_claude",
        name: toolName,
        input: followUpArguments(followUpTasks.claude),
      },
    ];
  }
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
      proof.claude.direct =
        instructions.includes(longClaudeRole) &&
        !instructions.includes("You are an agent working with the user") &&
        !prompt.includes(claudePrompt) &&
        JSON.stringify(body).includes(claudeUserRule);
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
const nativeUrl = "ws://127.0.0.1:" + reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const proxy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(proxy, "listening");
const upstreamUrl = "ws://127.0.0.1:" + proxy.address().port;
const nativeRequests = [];
proxy.on("connection", (client) => {
  const upstream = new WebSocket(nativeUrl);
  const pending = [];
  client.on("message", (bytes) => {
    const packet = JSON.parse(bytes);
    const { method, params } = packet;
    if (["thread/start", "thread/resume", "thread/fork"].includes(method)) {
      params.config = { ...params.config, bypass_hook_trust: true };
      const request = {
        method,
        documentLimit: params.config?.project_doc_max_bytes ?? null,
        projectTrust: params.config?.projects?.[cwd]?.trust_level ?? null,
      };
      nativeRequests.push(request);
      console.log(JSON.stringify(request));
    }
    const message = JSON.stringify(packet);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
    else pending.push(message);
  });
  upstream.on("open", () =>
    pending.forEach((message) => upstream.send(message)),
  );
  upstream.on("message", (bytes) => {
    if (client.readyState === WebSocket.OPEN) client.send(bytes.toString());
  });
  upstream.on("close", () => client.close());
  upstream.on("error", () => client.close());
  client.on("close", () => upstream.terminate());
});
await writeFile(
  join(codexHome, "config.toml"),
  [
    'model = "' + codexModel + '"',
    'model_provider = "fixture"',
    'approval_policy = "never"',
    'project_root_markers = [".fixture-root"]',
    "[model_providers.fixture]",
    'name = "fixture"',
    'base_url = "http://127.0.0.1:' + codex.address().port + '/v1"',
    'wire_api = "responses"',
    `[projects.${JSON.stringify(ancestor)}]`,
    'trust_level = "trusted"',
    "[features]",
    "hooks = true",
    codexHook(codexUserHook),
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
const launchCodex = () =>
  spawn("codex", ["app-server", "--listen", nativeUrl], {
    env: { ...process.env, CODEX_HOME: codexHome },
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
let errors = "";
function startAppServer() {
  const child = launchCodex();
  child.stderr.on("data", (chunk) => {
    errors = (errors + chunk).slice(-5000);
  });
  return child;
}
let native = startAppServer();
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
const continuedBranches = new Map();
const legacy = new Map();
const converted = new Map();
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
    let { thread } = await rpc("thread/start", {
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
    await directTurn(origin, params, standardPrompt + " CONTEXT_PROBE_EXPERT");
    assert.equal(proof[origin].standard, true);
    const originalId = thread.id;
    legacy.set(origin, { ...params });
    const continuation = await rpc("lan/delegation/mode/set", {
      threadId: originalId,
      delegationMode: true,
    });
    assert.notEqual(continuation.thread.id, originalId);
    assert.equal(
      (await rpc("thread/read", { threadId: originalId })).thread
        .delegationMode,
      false,
    );
    thread = continuation.thread;
    threads[origin] = thread.id;
    params.threadId = thread.id;
    await directTurn(
      origin,
      params,
      directPrompt + " CONTEXT_PROBE_SWITCHED",
      false,
    );
    assert.equal(proof[origin].direct, true);
    const { data: copied } = await rpc("thread/turns/list", {
      threadId: thread.id,
      sortDirection: "asc",
      itemsView: "full",
    });
    const retained = copied.find((turn) =>
      JSON.stringify(turn).includes(standardPrompt),
    );
    assert(retained, "转入秘书后原用户与助手轮次可见");
    const projectedDetail = await rpc("thread/read", {
      threadId: thread.id,
      includeTurns: true,
    });
    assert(
      projectedDetail.thread.turns.some((turn) => turn.id === retained.id),
    );
    assert.equal(projectedDetail.thread.forkedFromId, originalId);
    const { thread: projectedBranch } = await rpc("thread/fork", {
      ...params,
      lastTurnId: retained.id,
    });
    assert.equal(projectedBranch.delegationMode, true);
    const branchParams = { ...params, threadId: projectedBranch.id };
    await directTurn(
      origin,
      branchParams,
      directPrompt + " CONTEXT_PROBE_PROJECTED_FORK",
    );
    await rpc("thread/compact/start", { threadId: projectedBranch.id });
    await until(async () => {
      const { compaction } = await rpc("lan/compaction/check", {
        threadId: projectedBranch.id,
      });
      if (compaction?.status === "failed")
        throw new Error(JSON.stringify(compaction));
      return compaction?.status === "completed";
    }, origin + " 投影历史分支整理");
    await directTurn(
      origin,
      branchParams,
      directPrompt + " CONTEXT_PROBE_PROJECTED_COMPACT",
    );
    continuedBranches.set(origin, branchParams);
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
    followUpTasks[origin] = agent.delegation.taskId;
    const successTool = events.find(
      ({ method, params }) =>
        method === "item/completed" &&
        params.turnId === delegationTurn.id &&
        params.item?.arguments?.request_id === "native-" + origin,
    )?.params.item;
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
    await directTurn(origin, params, scopePrompt);
    assert(JSON.stringify(scopeProof[origin])?.includes(scopeError));
    if (origin === "claude") assert.equal(scopeProof.claude.is_error, true);
    const rejectedTool = events.findLast(
      ({ method, params }) =>
        method === "item/completed" &&
        params.threadId === thread.id &&
        params.item?.arguments?.request_id === "scope-conflict",
    )?.params.item;
    assert(rejectedTool);
    assert(successTool);
    assert(
      rejectedTool.status === "failed" || rejectedTool.result?.isError,
      JSON.stringify(rejectedTool),
    );
    if (origin === "claude") assert.equal(rejectedTool.result, null);
    if (process.env.DELEGATION_TOOL_PROOF_DIR)
      await writeFile(
        join(process.env.DELEGATION_TOOL_PROOF_DIR, origin + "-tools.json"),
        JSON.stringify({ success: successTool, failure: rejectedTool }),
      );
    console.log(origin + " 原生委派续问失败", JSON.stringify(rejectedTool));
    await rpc("lan/delegation/mode/set", {
      threadId: thread.id,
      delegationMode: false,
    });
    await directTurn(origin, params, offPrompt, true);
    assert.equal(proof[origin].off, true);

    const { thread: fresh, delegationMode } = await rpc("thread/start", {
      backendId: origin,
      ...(origin === "claude" && { cwd }),
      model,
      ...provider,
      delegationMode: true,
    });
    assert.equal(delegationMode, true);
    assert.equal(fresh.delegationMode, true);
    assert.equal(fresh.cwd, cwd);
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
    await directTurn(
      origin,
      freshParams,
      directPrompt + " CONTEXT_PROBE_START",
    );
    assert.equal(proof[origin].direct, true);
    const branch = await rpc("thread/fork", freshParams);
    assert.equal(branch.thread.delegationMode, true);
    await directTurn(
      origin,
      { ...freshParams, threadId: branch.thread.id },
      directPrompt + " CONTEXT_PROBE_FORK",
    );
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
  await shutdownBrowserClaudeWorker(config);
  // Simulate the persisted state created by the old in-place mode toggle.
  const configBackends = (await configuration.read()).backends;
  const oldIndex = join(
    configBackends.find(({ id }) => id === "claude").stateDir,
    "claudex-web-index.json",
  );
  const oldIndexData = JSON.parse(await readFile(oldIndex, "utf8"));
  const oldModes = createDelegationModes(root);
  for (const [origin, params] of legacy) {
    const { nativeId } = resourceTarget(params.threadId);
    const backend = configBackends.find(({ id }) => id === origin);
    await oldModes.save(backend, nativeId, true);
    if (origin === "claude") {
      const record = oldIndexData.sessions[nativeId];
      record.delegationMode = true;
      assert.equal(record.secretaryHistoryVersion, undefined);
    }
  }
  await writeFile(oldIndex, JSON.stringify(oldIndexData));
  const previousNative = native.pid;
  native.kill();
  await once(native, "exit");
  native = startAppServer();
  assert.notEqual(native.pid, previousNative);
  console.log(
    JSON.stringify({
      appServerRestart: { before: previousNative, after: native.pid },
    }),
  );
  await start();
  for (const [origin, params] of legacy) {
    const read = await rpc("thread/read", {
      threadId: params.threadId,
      includeTurns: true,
    });
    assert.equal(read.thread.delegationMode, true);
    assert.equal(read.thread.secretaryContinuationRequired, true);
    const page = await rpc("thread/turns/list", {
      threadId: params.threadId,
      itemsView: "full",
    });
    assert(
      page.data.some((turn) => JSON.stringify(turn).includes(standardPrompt)),
    );
    const nativeBefore = nativeRequests.length;
    const rejected = [];
    for (const method of [
      "thread/resume",
      "thread/fork",
      "thread/compact/start",
      "turn/start",
    ]) {
      const input = [
        { type: "text", text: directPrompt + " CONTEXT_PROBE_LEGACY_BLOCKED" },
      ];
      await assert.rejects(
        rpc(method, { ...params, input }),
        /转换为干净秘书续接/,
      );
      rejected.push(method);
    }
    assert.equal(nativeRequests.length, nativeBefore);
    assert(!lifecycle.has(origin + ":CONTEXT_PROBE_LEGACY_BLOCKED"));
    console.log(
      JSON.stringify({
        backend: origin,
        legacyAfterRestart: true,
        rejected,
        nativeForwarded: false,
      }),
    );
    const { thread } = await rpc("lan/delegation/mode/set", {
      threadId: params.threadId,
      model: params.model,
      delegationMode: true,
    });
    assert.notEqual(thread.id, params.threadId);
    assert.equal(
      (await rpc("thread/read", { threadId: params.threadId })).thread
        .secretaryContinuationRequired,
      true,
    );
    const clean = { ...params, threadId: thread.id };
    converted.set(origin, clean);
    assert.equal(
      (await rpc("thread/resume", clean)).thread.secretaryContinuationRequired,
      false,
    );
    await directTurn(
      origin,
      clean,
      directPrompt + " CONTEXT_PROBE_LEGACY_CONVERTED",
    );
    const { thread: fork } = await rpc("thread/fork", clean);
    await directTurn(
      origin,
      { ...clean, threadId: fork.id },
      directPrompt + " CONTEXT_PROBE_LEGACY_CONVERTED_FORK",
    );
    await rpc("lan/delegation/mode/set", {
      threadId: params.threadId,
      delegationMode: false,
    });
    assert.equal(
      (await rpc("thread/resume", params)).thread.delegationMode,
      false,
    );
    await directTurn(
      origin,
      params,
      standardPrompt + " CONTEXT_PROBE_LEGACY_ORDINARY",
    );
  }
  await manager.close();
  await conversations.close();
  await shutdownBrowserClaudeWorker(config);
  const beforeConvertedRestart = native.pid;
  native.kill();
  await once(native, "exit");
  native = startAppServer();
  await start();
  console.log(
    JSON.stringify({
      convertedRestart: { before: beforeConvertedRestart, after: native.pid },
    }),
  );
  for (const [origin, params] of converted) {
    assert.equal(
      (await rpc("thread/resume", params)).thread.secretaryContinuationRequired,
      false,
    );
    await directTurn(
      origin,
      params,
      directPrompt + " CONTEXT_PROBE_LEGACY_CONVERTED_RESTART",
    );
  }
  for (const [origin, params] of continuedBranches) {
    assert.equal(
      (await rpc("thread/resume", params)).thread.delegationMode,
      true,
    );
    await directTurn(
      origin,
      params,
      directPrompt + " CONTEXT_PROBE_PROJECTED_RESTART",
    );
  }
  for (const [origin, params] of optedIn) {
    proof[origin].direct = undefined;
    assert.equal(
      (await rpc("thread/resume", params)).thread.delegationMode,
      true,
    );
    await directTurn(origin, params, directPrompt + " CONTEXT_PROBE_RESTART");
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
  for (const origin of ["codex", "claude"]) {
    for (const phase of [
      "EXPERT",
      "SWITCHED",
      "PROJECTED_FORK",
      "PROJECTED_COMPACT",
      "PROJECTED_RESTART",
      "LEGACY_CONVERTED",
      "LEGACY_CONVERTED_FORK",
      "LEGACY_CONVERTED_RESTART",
      "LEGACY_ORDINARY",
      "START",
      "FORK",
      "RESTART",
      "DELEGATION",
    ]) {
      const stage =
        phase === "DELEGATION" ? "EXPERT_DELEGATION" : "CONTEXT_PROBE_" + phase;
      const record = lifecycle.get(origin + ":" + stage);
      assert(record, origin + " " + stage);
      assert.equal(record.user, true, origin + " " + stage);
      if (phase === "SWITCHED" || phase === "LEGACY_CONVERTED")
        assert.equal(record.conversation, true, origin);
      assert.deepEqual(
        record.hits,
        ["EXPERT", "DELEGATION", "LEGACY_ORDINARY"].includes(phase)
          ? record.expected
          : [],
        origin + " " + stage,
      );
    }
  }
  for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
    assert(
      nativeRequests.some(
        (request) =>
          request.method === method &&
          request.documentLimit === 0 &&
          request.projectTrust === "untrusted",
      ),
      method,
    );
  }
  console.log(
    "Codex → Claude Code 和 Claude Code → Codex 原生 MCP 双向委派及步骤查询通过",
  );
  console.log("双向委派发起会话在派单轮次结束后持续活跃，结果回投结算后退出");
  console.log("Claude Bash 和 Write 均可执行");
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
  proxy.close();
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

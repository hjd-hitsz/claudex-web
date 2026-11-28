import test from "node:test";
import assert from "node:assert/strict";
import { messagesRequest } from "../src/backends/claude/messages-request.mjs";
import {
  providerRuntimeEnvironment,
  providerModelEnvironment,
} from "../src/backends/claude/provider-environment.mjs";
import { modelOptions } from "../src/backends/claude/model-options.mjs";
import { readPromptSections, renderPrompt } from "../src/prompts.mjs";

test("模型支持元数据交给原生能力规则，保持思考启停独立", () => {
  assert.equal(
    modelOptions({ protocol: "messages_compatible" }, "custom", {}).thinking,
    undefined,
  );
  for (const enabled of [true, false])
    assert.deepEqual(
      modelOptions(
        {
          protocol: "messages_compatible",
          modelCapabilities: { custom: { supportsAdaptiveThinking: enabled } },
        },
        "custom",
        {},
      ).thinking,
      undefined,
    );
  assert.equal(
    providerModelEnvironment(
      {
        modelCapabilities: {
          custom: {
            supportsAdaptiveThinking: false,
            supportedEffortLevels: ["xhigh"],
          },
        },
      },
      "custom",
      "xhigh",
    ).CLAUDE_CODE_MODEL_CAPABILITIES,
    "custom=-adaptive_thinking,effort,xhigh_effort,-max_effort",
  );
});

test("标准 Messages 保留原生思考控制、空工具与评估 schema", () => {
  const body = {
    model: "custom-model",
    messages: [{ role: "user", content: "检查条件" }],
    tools: [],
    output_config: {
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    },
  };
  const translated = messagesRequest(body);
  assert.deepEqual(translated.thinking, { type: "disabled" });
  assert.deepEqual(translated.tools, []);
  assert.deepEqual(translated.output_config, body.output_config);
  assert.equal(body.thinking, undefined, "保持原生输入快照独立");
  for (const thinking of [
    { type: "disabled" },
    { type: "adaptive" },
    { type: "enabled", budget_tokens: 4096 },
  ])
    assert.deepEqual(
      messagesRequest({ ...body, thinking }).thinking,
      thinking,
      "原生显式控制完整传递",
    );
});

test("配置供应商的秘书请求合并系统正文并保留最新项目规则", () => {
  const secretaryRole = "Secretary role from the session";
  const identity =
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
  const agentTypes = "Available agent types for the Agent tool:";
  const environment = [
    "# Environment",
    "Workspace context",
    "",
    agentTypes,
    "- claude: default",
    "- claudex-secretary: named agent",
    "",
    "Enabled skill list",
  ].join("\n");
  const frame = readPromptSections("backends/claude/execution.md")(
    "projectInstructions",
  );
  const snapshot = (files) =>
    "UserPromptSubmit hook additional context: " +
    renderPrompt(frame, { cwd: '"/fixture"', files });
  const user = { role: "user", content: agentTypes };
  const cacheControl = { type: "ephemeral" };
  const body = {
    system: [
      { type: "text", text: "x-anthropic-billing-header: fixture" },
      { type: "text", text: identity },
      { type: "text", text: secretaryRole },
    ],
    messages: [
      user,
      { role: "system", content: environment + "\n\n" + snapshot("older") },
      {
        role: "system",
        content: [
          {
            type: "text",
            text: snapshot("current"),
            cache_control: cacheControl,
          },
        ],
      },
    ],
    tools: [{ name: "Bash" }],
  };
  const result = messagesRequest(body, { standard: true, secretaryRole });
  assert.deepEqual(result.messages, [user]);
  assert.deepEqual(result.tools, body.tools);
  assert.equal(result.system.length, 1);
  assert.equal(result.system[0].cache_control, cacheControl);
  const text = result.system[0].text;
  assert.equal(text.split("\n")[0], secretaryRole);
  assert(
    text.includes("Workspace context") && text.includes("Enabled skill list"),
  );
  assert(text.includes(snapshot("current")));
  for (const removed of [
    identity,
    agentTypes,
    "x-anthropic-billing-header:",
    snapshot("older"),
  ])
    assert(!text.includes(removed));
  assert.equal(result.thinking?.type, "disabled");

  const native = messagesRequest(body, { standard: false, secretaryRole });
  assert.equal(native.messages, body.messages);
  assert.equal(native.tools, body.tools);
  assert.deepEqual(native.system, [{ type: "text", text: secretaryRole }]);
  assert.equal(native.thinking, undefined);
  assert.equal(messagesRequest(body, { standard: false }), body);
  assert.equal(messagesRequest(body).system[1].text, identity);
  assert.equal(
    messagesRequest(body, { secretaryRole: "Different role", standard: false }),
    body,
  );

  const projectUsesHeading = snapshot(agentTypes + "\n- user-defined rule");
  const ownRules = {
    ...body,
    messages: [
      { role: "system", content: "# Environment\n\n" + projectUsesHeading },
    ],
  };
  assert(
    messagesRequest(ownRules, { secretaryRole }).system[0].text.includes(
      projectUsesHeading,
    ),
  );
});

test("原生秘书请求只将组内系统消息移到完整工具组之后", () => {
  const secretaryRole = "Session secretary";
  const historySystem = (text) => ({
    role: "system",
    content: [{ type: "text", text, cache_control: { type: "ephemeral" } }],
  });
  const before = historySystem("before tool group");
  const first = historySystem("before first result");
  const second = historySystem("between results");
  const after = historySystem("after tool group");
  const call = {
    role: "assistant",
    content: [
      { type: "tool_use", id: "first", name: "Read", input: {} },
      { type: "tool_use", id: "second", name: "Read", input: {} },
    ],
  };
  const result = (id) => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: id }],
  });
  const firstResult = result("first");
  const secondResult = result("second");
  const original = [
    before,
    call,
    first,
    firstResult,
    second,
    secondResult,
    after,
  ];
  const body = { system: secretaryRole, messages: [...original] };
  const native = messagesRequest(body, { standard: false, secretaryRole });
  assert.deepEqual(native.messages, [
    before,
    call,
    firstResult,
    secondResult,
    first,
    second,
    after,
  ]);
  assert.equal(native.messages[4], first);
  assert.equal(native.messages[5], second);
  assert.deepEqual(body.messages, original);
  const compatible = messagesRequest(body, { standard: true, secretaryRole });
  assert.deepEqual(compatible.messages, [call, firstResult, secondResult]);
  assert.equal(
    compatible.system[0].text,
    [
      secretaryRole,
      ...[before, first, second, after].map((m) => m.content[0].text),
    ].join("\n\n"),
  );

  const incomplete = { ...body, messages: [call, first, result("other")] };
  assert.equal(
    messagesRequest(incomplete, { standard: false, secretaryRole }).messages,
    incomplete.messages,
  );
});

test("供应商环境保留结构化输出所需的原生功能并按实际选择传递 effort", () => {
  const provider = {
    protocol: "messages_compatible",
    baseUrl: "https://provider.example",
    apiKey: "fixture",
    models: ["custom-model"],
  };
  const backend = { dataDir: "/tmp/claude-environment-test" };
  const automatic = providerRuntimeEnvironment(provider, backend);
  assert.equal(automatic.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, undefined);
  assert.equal(automatic.CLAUDE_CODE_EFFORT_LEVEL, "unset");
  assert.equal(
    providerRuntimeEnvironment(provider, backend, { effort: "low" })
      .CLAUDE_CODE_EFFORT_LEVEL,
    "low",
  );
});

test("初始化与逐轮模型设置同步主模型及三个原生别名", () => {
  const provider = {
    models: ["first", "second"],
    protocol: "messages_compatible",
  };
  for (const model of [undefined, "second", "first"]) {
    const current = model || "first";
    const update = providerModelEnvironment(provider, model);
    const initial = providerRuntimeEnvironment(
      provider,
      { dataDir: "/isolated" },
      { model },
    );
    for (const key of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ]) {
      assert.equal(update[key], current);
      assert.equal(initial[key], current);
    }
  }
});

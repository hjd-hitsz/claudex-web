import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBackendConfiguration,
  validateBackend,
} from "../src/backends/configuration.mjs";
import { subagentModelParams } from "../src/backends/codex/subagent-model.mjs";
import {
  providerRuntimeEnvironment,
  providerSettingsEnvironment,
} from "../src/backends/claude/provider-environment.mjs";
import { createProviderTransport } from "../src/backends/claude/provider-transport.mjs";
import { nativeProviderHeaders } from "../src/backends/claude/native-provider.mjs";

test("原生子代理认证按请求读取 CLI 凭据，支持 API Key、Token 与 OAuth 文件更新", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "subagent-native-auth-"));
  const keys = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  t.after(async () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(directory, { recursive: true, force: true });
  });
  for (const key of keys) delete process.env[key];
  const backend = { dataDir: directory };
  await assert.rejects(nativeProviderHeaders(backend), /认证不可用/);
  await writeFile(
    join(directory, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "oauth-first" } }),
  );
  assert.equal(
    (await nativeProviderHeaders(backend)).authorization,
    "Bearer oauth-first",
  );
  await writeFile(
    join(directory, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "oauth-refreshed" } }),
  );
  assert.equal(
    (await nativeProviderHeaders(backend)).authorization,
    "Bearer oauth-refreshed",
  );
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-environment";
  assert.equal(
    (await nativeProviderHeaders(backend)).authorization,
    "Bearer oauth-environment",
  );
  process.env.ANTHROPIC_API_KEY = "native-key";
  assert.equal(
    (await nativeProviderHeaders(backend))["x-api-key"],
    "native-key",
  );
  process.env.ANTHROPIC_AUTH_TOKEN = "native-token";
  assert.equal(
    (await nativeProviderHeaders(backend)).authorization,
    "Bearer native-token",
  );
});

test("两个后端独立持久保存子代理模型，局部保存保留启停、代理及显示偏好，清空恢复默认", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "subagent-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = {
    configDir: directory,
    codexHome: join(directory, "codex"),
    claudeHome: join(directory, "claude"),
    upstreamUrl: "ws://127.0.0.1:1",
  };
  const settings = createBackendConfiguration(config);
  for (const id of ["codex", "claude"]) {
    await settings.save({
      id,
      type: id,
      enabled: false,
      ...(id === "codex"
        ? { hiddenModels: ["hidden"] }
        : { proxy: { mode: "off" } }),
    });
    await settings.save({
      id,
      type: id,
      subagentModel: ` ${id}-child `,
      subagentEffort: "high",
    });
  }
  let restored = await createBackendConfiguration(config).read();
  assert.deepEqual(
    restored.backends.map((backend) => backend.subagentModel),
    ["codex-child", "claude-child"],
  );
  assert.ok(restored.backends.every((backend) => !backend.enabled));
  assert.deepEqual(
    restored.backends.map((backend) => backend.subagentEffort),
    ["high", "high"],
  );
  assert.deepEqual(restored.backends[0].hiddenModels, ["hidden"]);
  assert.deepEqual(restored.backends[1].proxy, { mode: "off" });
  await settings.save({
    id: "claude",
    type: "claude",
    subagentProviderId: "vendor",
    subagentModel: "child",
  });
  assert.equal(
    (await settings.read()).backends[1].subagentProviderId,
    "vendor",
  );
  await settings.save({
    id: "claude",
    type: "claude",
    subagentProviderId: "",
    subagentModel: "",
    subagentEffort: "",
  });
  restored = await settings.read();
  assert.equal(restored.backends[1].subagentModel, "");
  assert.equal(restored.backends[0].subagentModel, "codex-child");
  assert.equal(restored.backends[0].subagentEffort, "high");
  assert.equal(restored.backends[1].subagentEffort, "");
  for (const subagentEffort of [null, "unknown", 1, "ultra"])
    assert.throws(
      () =>
        validateBackend(
          { id: "claude", type: "claude", subagentEffort },
          config,
        ),
      /思考强度/,
    );
  assert.equal(
    (await stat(join(directory, "backends.json"))).mode & 0o777,
    0o600,
  );
  for (const subagentModel of [null, 4, "with space", "a\nb", "x".repeat(257)])
    assert.throws(
      () =>
        validateBackend(
          { id: "claude", type: "claude", subagentModel },
          config,
        ),
      /子代理模型/,
    );
  assert.throws(
    () =>
      validateBackend(
        {
          id: "codex",
          type: "codex",
          subagentProviderId: "vendor",
          subagentModel: "child",
        },
        config,
      ),
    /Claude Code/,
  );
  assert.throws(
    () =>
      validateBackend(
        { id: "claude", type: "claude", subagentProviderId: "vendor" },
        config,
      ),
    /须指定模型/,
  );
});

test("Codex 首次创建、恢复及分支注入原生默认模型，保持主模型与其他配置", () => {
  const params = {
    model: "parent",
    config: {
      "mcp_servers.existing": { command: "existing" },
      "agents.max_threads": 3,
    },
  };
  for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
    const result = subagentModelParams(method, params, {
      subagentModel: "child",
      subagentEffort: "high",
    });
    assert.equal(result.model, "parent");
    assert.equal(result.config["agents.default_subagent_model"], "child");
    assert.equal(
      result.config["agents.default_subagent_reasoning_effort"],
      "high",
    );
    assert.equal(result.config["agents.max_threads"], 3);
    assert.equal(result.config["mcp_servers.existing"].command, "existing");
    assert.equal(
      subagentModelParams(method, params, { subagentModel: "" }),
      params,
    );
  }
  assert.equal(
    subagentModelParams("turn/start", params, { subagentModel: "child" }),
    params,
  );
  assert.equal(params.config["agents.default_subagent_model"], undefined);
  assert.equal(
    subagentModelParams("thread/start", params, { subagentEffort: "low" })
      .config["agents.default_subagent_reasoning_effort"],
    "low",
  );
});

test("Claude 首次环境与会话设置使用相同子代理配置，主模型切换保持子代理路由", () => {
  const backend = {
    dataDir: join(tmpdir(), "subagent-native"),
    subagentModel: "child",
    subagentEffort: "high",
  };
  const provider = {
    models: ["parent"],
    baseUrl: "https://example.test",
    apiKey: "key",
  };
  const proxy = {
    url: "http://127.0.0.1:1",
    token: "local",
    subagentModel: "opaque-child-route",
  };
  for (const make of [
    providerRuntimeEnvironment,
    providerSettingsEnvironment,
  ]) {
    const env = make(provider, backend, { proxy, model: "parent-next" });
    assert.equal(env.ANTHROPIC_MODEL, "parent-next");
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "opaque-child-route");
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, "1");
    assert.equal(env.CLAUDE_CODE_SUBAGENT_EFFORT, "high");
    assert.match(env.ANTHROPIC_CUSTOM_HEADERS, /x-claudex-proxy-token: local/);
  }
});

test("跨供应商按会话专属标识分流，同名模型各用正确凭据与协议，拒绝未授权本机请求", async (t) => {
  const received = [];
  async function endpoint(name) {
    const server = http.createServer(async (req, res) => {
      let text = "";
      for await (const bytes of req) text += bytes;
      received.push({
        name,
        path: req.url,
        headers: req.headers,
        body: JSON.parse(text),
      });
      res
        .writeHead(200, { "content-type": "application/json" })
        .end('{"ok":true}');
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    return `http://127.0.0.1:${server.address().port}`;
  }
  const main = {
    baseUrl: await endpoint("main"),
    apiKey: "main-key",
    protocol: "anthropic",
  };
  const child = {
    baseUrl: await endpoint("child"),
    apiKey: "child-key",
    protocol: "messages",
  };
  const transport = await createProviderTransport(main, {
    provider: child,
    model: "same-model",
    effort: "high",
  });
  t.after(() => transport.close());
  const body = {
    model: "same-model",
    output_config: { effort: "low" },
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "task" },
    ],
  };
  async function send(model, path = "/v1/messages") {
    return fetch(transport.url + path, {
      method: "POST",
      headers: {
        "x-claudex-proxy-token": transport.token,
        authorization: "Bearer local",
        "anthropic-organization-id": "main-org",
      },
      body: JSON.stringify({ ...body, model }),
    });
  }
  assert.equal((await send("same-model")).status, 200);
  assert.equal((await send(transport.subagentModel)).status, 200);
  assert.equal(
    (await send(transport.subagentModel, "/v1/messages/count_tokens")).status,
    200,
  );
  assert.equal(received[0].name, "main");
  assert.equal(received[0].headers.authorization, "Bearer main-key");
  assert.equal(received[0].body.messages[0].role, "system");
  assert.equal(received[0].body.output_config.effort, "low");
  for (const request of received.slice(1)) {
    assert.equal(request.name, "child");
    assert.equal(request.body.model, "same-model");
    assert.equal(request.headers.authorization, "Bearer child-key");
    assert.equal(request.headers["x-api-key"], "child-key");
    assert.equal(request.headers["x-claudex-proxy-token"], undefined);
    assert.equal(request.headers["anthropic-organization-id"], undefined);
    assert.equal(request.body.system[0].text, "system");
    assert.equal(
      request.body.output_config.effort,
      request.path.endsWith("count_tokens") ? "low" : "high",
    );
  }
  assert.equal(
    (await fetch(transport.url, { method: "POST", body: "{}" })).status,
    401,
  );
});

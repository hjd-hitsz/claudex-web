import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackendConfiguration } from "../src/backends/configuration.mjs";
import { createProviders } from "../src/backends/providers.mjs";

const deepseek = { id: "deepseek", backendId: "claude" };
const go = { id: "opencode-go", backendId: "claude" };
const list = (...data) => Response.json({ object: "list", data });
const flash = {
  id: "deepseek-flash",
  name: "Cloud alias",
  context_window: 64000,
  output_modalities: ["text"],
  api_capabilities: { anthropic_messages: {} },
};

async function service(t, fetchModels, timeout) {
  const configDir = await mkdtemp(
    join(tmpdir(), "claudex-provider-catalogue-"),
  );
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const configuration = createBackendConfiguration({
    configDir,
    codexHome: configDir,
    claudeHome: configDir,
    upstreamUrl: "ws://127.0.0.1:8765",
  });
  return createProviders(configuration, { fetchModels, timeout });
}

test("保存凭据后读取官方 DeepSeek 目录，保留现有配置并移除下线模型", async (t) => {
  const calls = [];
  const providers = await service(t, async (url, options) => {
    calls.push({ url, headers: options.headers, redirect: options.redirect });
    return list(
      flash,
      {
        ...flash,
        id: "deepseek-new-chat",
        name: "New Chat",
        effort: { supported_levels: ["low", "high", "none"] },
      },
      { id: "deepseek-embedding", type: "embedding" },
      { id: "deepseek-audio", output_modalities: ["audio"] },
      { id: "openai-only", api_capabilities: { responses: {} } },
    );
  });
  const result = await providers.request("lan/providers/save", {
    ...deepseek,
    apiKey: "deepseek-fixture",
    hiddenModels: ["deepseek-flash", "deepseek-v4-pro"],
  });
  const [provider] = result.providers;
  assert.deepEqual(calls, [
    {
      url: "https://api.deepseek.com/models",
      headers: { Authorization: "Bearer deepseek-fixture" },
      redirect: "error",
    },
  ]);
  assert.equal(result.catalogueError, undefined);
  assert.deepEqual(provider.models, ["deepseek-flash", "deepseek-new-chat"]);
  assert.deepEqual(provider.hiddenModels, ["deepseek-flash"]);
  assert.equal(provider.modelAliases["deepseek-flash"], "DeepSeek Flash");
  assert.equal(
    provider.modelCapabilities["deepseek-flash"].contextWindow,
    1048576,
  );
  assert.equal(provider.modelAliases["deepseek-new-chat"], "New Chat");
  assert.deepEqual(
    provider.modelCapabilities["deepseek-new-chat"].supportedEffortLevels,
    ["low", "high"],
  );
  assert.ok(provider.catalogueUpdatedAt > 0);
  assert.doesNotMatch(JSON.stringify(result), /deepseek-fixture/);
  const other = (
    await providers.list("claude", { includeDisabled: true })
  ).find(({ id }) => id === go.id);
  assert.equal(other.models.length, 31);
});

test("Go 预览使用输入的 Bearer 凭据，过滤目录并将保存目录留给原凭据", async (t) => {
  const providers = await service(t, async (url, { headers }) => {
    assert.equal(url, "https://opencode.ai/inference/go/v1/models");
    assert.equal(headers.Authorization, "Bearer preview-fixture");
    return list(
      {
        object: "model",
        id: "beam-free",
        type: "chat",
        name: "Beam Free",
        capabilities: { tools: { supported: true } },
      },
      {
        object: "model",
        id: "chat-added",
        type: "chat",
        name: "Added",
        limit: { context: 131072 },
      },
      { object: "model", id: "jev-1.14", type: "decision" },
      { object: "model", id: "text-embedding-3-small", type: "embedding" },
      {
        object: "model",
        id: "tools-unsupported",
        type: "chat",
        capabilities: { tools: { supported: false } },
      },
    );
  });
  await providers.save({
    ...go,
    apiKey: "saved-fixture",
    hiddenModels: ["beam-free"],
  });
  const response = await providers.request("lan/providers/refresh", {
    id: go.id,
    apiKey: "preview-fixture",
  });
  assert.equal(response.preview, true);
  assert.deepEqual(response.provider.models, ["beam-free", "chat-added"]);
  assert.deepEqual(response.provider.hiddenModels, ["beam-free"]);
  const saved = await providers.get("claude", go.id);
  assert.equal(saved.models.length, 31);
  assert.equal(saved.apiKey, "saved-fixture");
  await assert.rejects(
    providers.request("lan/providers/refresh", {
      id: go.id,
      url: "http://localhost",
    }),
    /只接受/,
  );
  await assert.rejects(
    providers.request("lan/providers/refresh", {
      id: "custom",
      apiKey: "some-key",
    }),
    /手工模型目录/,
  );
});

test("认证、超时和网络失败保留最近成功的一份目录及隐藏选择", async (t) => {
  let outcome;
  const providers = await service(
    t,
    async (_url, { signal }) => {
      if (outcome === 401) return new Response(null, { status: 401 });
      if (outcome === "network") throw new TypeError("network fixture");
      if (outcome === "timeout")
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          setTimeout(() => reject(new Error("test timeout")), 50);
        });
      return list(flash);
    },
    10,
  );
  const {
    providers: [initial],
  } = await providers.request("lan/providers/save", {
    ...deepseek,
    apiKey: "old-fixture",
    hiddenModels: [flash.id],
  });
  for (const [next, error] of [
    [401, /认证失败（HTTP 401）/],
    ["timeout", /请求超时/],
    ["network", /网络请求失败/],
  ]) {
    outcome = next;
    await assert.rejects(
      providers.request("lan/providers/refresh", { id: deepseek.id }),
      error,
    );
    assert.deepEqual((await providers.list())[0], initial);
  }
  const updated = await providers.request("lan/providers/save", {
    ...deepseek,
    apiKey: "new-fixture",
  });
  assert.match(updated.catalogueError, /网络请求失败/);
  assert.deepEqual(updated.providers[0], initial);
  assert.equal(
    (await providers.get("claude", deepseek.id)).apiKey,
    "new-fixture",
  );
});

test("并发请求合并，同一 Key 的隐藏保存与刷新合并，旧凭据代次不能覆盖", async (t) => {
  let started,
    deliver,
    calls = 0;
  const waitForNextFetch = () =>
    new Promise((resolve) => {
      started = resolve;
    });
  const providers = await service(t, () => {
    calls++;
    return new Promise((resolve) => {
      deliver = resolve;
      started();
    });
  });
  await providers.save({ ...deepseek, apiKey: "same-fixture" });
  let fetching = waitForNextFetch();
  const one = providers.request("lan/providers/refresh", { id: deepseek.id });
  const two = providers.request("lan/providers/refresh", { id: deepseek.id });
  await fetching;
  await providers.save({ ...deepseek, hiddenModels: [flash.id] });
  deliver(list(flash));
  const [first, second] = await Promise.all([one, two]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(first.provider.hiddenModels, [flash.id]);
  fetching = waitForNextFetch();
  const stale = providers.request("lan/providers/refresh", { id: deepseek.id });
  await fetching;
  await providers.save({ ...deepseek, apiKey: "" });
  await providers.save({ ...deepseek, apiKey: "same-fixture" });
  deliver(list({ ...flash, id: "stale" }));
  await assert.rejects(stale, /API Key 已更新/);
  assert.deepEqual((await providers.list())[0].models, [flash.id]);
});

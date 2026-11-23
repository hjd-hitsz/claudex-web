import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviders } from "../src/backends/providers.mjs";
import { createBackendConfiguration } from "../src/backends/configuration.mjs";
import { createOpenCodeCatalogue } from "../src/backends/opencode/catalogue.mjs";
import { createOpenCodeAccount } from "../src/backends/opencode/account.mjs";

test("OpenCode 共用现有模型服务商，ChatGPT 模型来自本机 Codex", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opencode-providers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const providers = createProviders(
    createBackendConfiguration({
      configDir: root,
      codexHome: join(root, "codex"),
      claudeHome: join(root, "claude"),
      upstreamUrl: "ws://127.0.0.1:8765",
    }),
  );
  await providers.save({
    id: "custom",
    backendId: "claude",
    name: "自定义模型",
    protocol: "messages",
    baseUrl: "https://example.org/anthropic",
    apiKey: "isolated-key",
    models: ["model-a"],
    modelAliases: { "model-a": "模型 A" },
  });
  assert.deepEqual(
    (await providers.list("opencode")).map((p) => p.id),
    ["custom"],
  );
  assert.deepEqual(await providers.list("codex"), []);
  assert.equal(
    (await providers.get("opencode", "custom")).apiKey,
    "isolated-key",
  );
  const nativeModels = [
    "claudex-custom/model-a",
    "openai/gpt-test",
    "other/model-b",
  ].map((value) => {
    const [providerID, id] = value.split("/");
    return {
      providerID,
      id,
      name: id,
      enabled: true,
      variants: [],
      limit: { context: 32768 },
    };
  });
  for (const suffix of ["fast", "ultrafast", "pro"])
    nativeModels.push({
      ...nativeModels[1],
      id: `gpt-test-${suffix}`,
      modelID: "gpt-test",
      name: `GPT Test ${suffix}`,
    });
  let authenticated = false;
  const sdk = () => ({
    location: { reload: async () => {} },
    model: { list: async () => ({ data: nativeModels }) },
  });
  const subscription = {
    sync: async () =>
      authenticated
        ? {
            models: ["gpt-test"],
            modelCatalogue: [
              {
                model: "gpt-test",
                defaultReasoningEffort: "low",
                supportedReasoningEfforts: [
                  { reasoningEffort: "low" },
                  { reasoningEffort: "high" },
                ],
                serviceTiers: [
                  { id: "priority", name: "Fast" },
                  { id: "ultrafast", name: "Ultrafast" },
                ],
              },
            ],
          }
        : null,
    read: async () =>
      authenticated
        ? { account: { type: "chatgpt", email: "demo@example.test" } }
        : null,
  };
  const catalogue = createOpenCodeCatalogue({
    sdk,
    providers,
    backend: { stateDir: root },
    active: new Map(),
    subscription,
  });
  assert.deepEqual(
    (await catalogue.models(root)).map((m) => m.model),
    ["claudex-custom/model-a"],
  );
  const config = JSON.parse(await readFile(catalogue.file, "utf8"));
  assert.equal(config.providers["claudex-custom"].package, "@ai-sdk/anthropic");
  assert.equal(
    config.providers["claudex-custom"].settings.baseURL,
    "https://example.org/anthropic/v1",
  );
  assert.equal(
    config.providers["claudex-custom"].models["model-a"].name,
    "模型 A",
  );
  assert.equal(Object.keys(config.providers).length, 1);
  authenticated = true;
  const gpt = (await catalogue.models(root)).find(
    (model) => model.providerName === "ChatGPT",
  );
  assert.deepEqual(
    gpt.serviceTiers.map((tier) => tier.id),
    ["priority", "ultrafast"],
  );
  assert.equal(gpt.defaultReasoningEffort, "low");
  assert.equal(gpt.supportedReasoningEfforts.length, 2);
  assert.deepEqual(
    (await catalogue.models(root)).map((m) => m.providerName),
    ["自定义模型", "ChatGPT"],
  );
  const account = createOpenCodeAccount({ providers, subscription });
  assert.equal(
    (await account.request("account/read", { model: "openai/gpt-test" }))
      .account.type,
    "chatgpt",
  );
  await assert.rejects(
    account.request("account/login/start", {}),
    /Codex 后端/,
  );
  authenticated = false;
  assert.deepEqual(
    (await catalogue.models(root)).map((m) => m.model),
    ["claudex-custom/model-a"],
  );
  assert.equal(
    (await account.request("account/read", { model: "openai/gpt-test" }))
      .account,
    null,
  );
});

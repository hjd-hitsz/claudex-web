import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProviders } from "../../server/src/backends/providers.mjs";
import { createOpenCodeAdapter } from "../../server/src/backends/opencode/adapter.mjs";
import { loadOpenCode } from "../../server/src/backends/opencode/runtime.mjs";

assert.ok(process.env.OPENCODE_SDK_ENTRY);
assert.ok(process.env.OPENCODE_PROVIDERS_FILE);
const saved = JSON.parse(
  await readFile(process.env.OPENCODE_PROVIDERS_FILE, "utf8"),
);
const providers = await createProviders({
  readProviders: async () => saved.providers || [],
}).list("opencode");
const root = await mkdtemp(join(tmpdir(), "opencode-model-catalogue-"));
Object.assign(process.env, {
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
});
const OpenCode = await loadOpenCode(resolve(process.env.OPENCODE_SDK_ENTRY));
const adapter = createOpenCodeAdapter({
  backend: { id: "opencode", type: "opencode", stateDir: join(root, "web") },
  config: {
    configDir: join(root, "web"),
    codexHome: process.env.CODEX_HOME || join(homedir(), ".codex"),
    defaultCwd: root,
    projectlessRoot: join(root, "workspaces"),
  },
  providers: {
    list: async () => providers,
    // Catalogue reads preserve configured names and capabilities, without
    // passing any saved provider credential to the isolated runtime.
    get: async (_, id) => ({
      ...providers.find((provider) => provider.id === id),
      apiKey: "catalogue-only",
    }),
  },
  createHost: (options) =>
    OpenCode.create({
      ...options,
      database: { path: join(root, "opencode.db") },
      config: {
        ...options.config,
        claude: false,
        directory: join(root, "config"),
      },
      models: { fetch: false },
      fs: { filewatcher: false },
      fetch: () => {
        throw new Error("模型目录验收不发送推理请求。");
      },
    }),
  send: (client, message) => client.deliver(message),
  broadcast() {},
});
try {
  await adapter.connect();
  let response;
  await adapter.receive(
    { deliver: (message) => (response = message) },
    { id: 1, method: "model/list", params: { cwd: root } },
  );
  assert.ok(!response.error, response.error?.message);
  const models = response.result.data;
  assert.ok(models.some((model) => model.providerName === "ChatGPT"));
  for (const model of models.filter(
    (model) => model.providerName === "ChatGPT",
  )) {
    assert.doesNotMatch(model.model, /-(fast|ultrafast|pro)$/);
    assert.ok(model.serviceTiers?.length);
    assert.ok(model.supportedReasoningEfforts.length > 1);
  }
  for (const model of models) {
    assert.ok(model.displayName && model.providerName);
    assert.equal(model.displayName.includes(" · "), false, model.displayName);
  }
  await mkdir(".cache/opencode", { recursive: true });
  await writeFile(
    ".cache/opencode/real-model-catalogue.json",
    JSON.stringify(
      { sdk: "2.3.2", models, providers, inferenceRequests: 0 },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      models.map(({ model, displayName, providerName }) => ({
        model,
        displayName,
        providerName,
      })),
      null,
      2,
    ),
  );
} finally {
  await adapter.close();
  await rm(root, { recursive: true, force: true });
}

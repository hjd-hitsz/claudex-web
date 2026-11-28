import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackendConfiguration } from "../src/backends/configuration.mjs";
import { createProviders } from "../src/backends/providers.mjs";

test("旧 Claude 隐藏条目按供应商迁移，随后原子保存且不反转显示选择", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "provider-visibility-"));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const config = {
    configDir,
    codexHome: join(configDir, "codex"),
    claudeHome: join(configDir, "claude"),
    upstreamUrl: "ws://127.0.0.1:8765",
  };
  const custom = {
    backendId: "claude",
    protocol: "anthropic",
    name: "Custom",
    baseUrl: "https://fixture.example",
    models: ["deepseek-flash", "other"],
    apiKey: "fixture-key",
  };
  const key = (id, model) => JSON.stringify([id, model]);
  const unknown = key("unknown", "future");
  const file = join(configDir, "backends.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      backends: [
        { id: "codex", type: "codex", enabled: true, hiddenModels: ["gpt"] },
        {
          id: "claude",
          type: "claude",
          enabled: true,
          hiddenModels: [
            "sonnet",
            key("@native", "opus"),
            unknown,
            key("deepseek", "deepseek-flash"),
            key("custom", "other"),
            key("explicit", "other"),
          ],
        },
      ],
      providers: [
        { ...custom, id: "custom" },
        { ...custom, id: "explicit", hiddenModels: [] },
      ],
    }),
  );
  const store = createBackendConfiguration(config);
  const service = createProviders(store);
  const forEditing = async () =>
    Object.fromEntries(
      (await service.list("claude", { includeDisabled: true })).map(
        ({ id, hiddenModels }) => [id, hiddenModels],
      ),
    );
  assert.deepEqual(await forEditing(), {
    deepseek: ["deepseek-flash"],
    "opencode-go": [],
    custom: ["other"],
    explicit: [],
  });
  assert.equal((await service.get("claude", "custom")).apiKey, "fixture-key");
  const { backends } = await store.read();
  assert.deepEqual(backends.find((row) => row.id === "claude").hiddenModels, [
    "sonnet",
    "opus",
    unknown,
  ]);
  assert.deepEqual(backends.find((row) => row.id === "codex").hiddenModels, [
    "gpt",
  ]);
  await Promise.all([
    service.save({
      ...custom,
      id: "custom",
      apiKey: undefined,
      hiddenModels: [],
    }),
    store.save({
      id: "claude",
      type: "claude",
      hiddenModels: ["sonnet", "opus", unknown],
    }),
  ]);
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(
    stored.providers.find((row) => row.id === "deepseek").hiddenModels,
    ["deepseek-flash"],
  );
  assert.equal(
    stored.providers.find((row) => row.id === "custom").apiKey,
    "fixture-key",
  );
  const reloaded = createProviders(createBackendConfiguration(config));
  assert.deepEqual(
    (await reloaded.list()).find((row) => row.id === "custom").hiddenModels,
    [],
  );
  await assert.rejects(
    service.save({ ...custom, hiddenModels: [1] }),
    /隐藏模型列表无效/,
  );
});

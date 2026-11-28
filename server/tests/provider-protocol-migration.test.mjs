import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackendConfiguration } from "../src/backends/configuration.mjs";
import { createProviders } from "../src/backends/providers.mjs";
import { providerPresets } from "../src/backends/provider-presets.mjs";

const provider = {
  id: "custom",
  backendId: "claude",
  name: "Fixture",
  baseUrl: "https://example.org",
  models: ["model"],
  apiKey: "fixture-key",
  hiddenModels: ["model"],
};

async function fixture(t, overrides) {
  const configDir = await mkdtemp(
    join(tmpdir(), "provider-protocol-migration-"),
  );
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const backendsFile = join(configDir, "backends.json");
  const config = {
    configDir,
    claudeHome: join(configDir, "claude"),
    codexHome: join(configDir, "codex"),
    upstreamUrl: "ws://127.0.0.1:8765",
    backendsFile,
  };
  const data = {
    version: 1,
    backends: [{ id: "claude", type: "claude", enabled: true }],
    providers: [],
    ...overrides,
  };
  const original = JSON.stringify(data);
  await writeFile(backendsFile, original, { mode: 0o600 });
  return { config, data, original, store: createBackendConfiguration(config) };
}

for (const version of [1, undefined]) {
  test(`旧供应商协议原子迁移并保留原有配置 (version=${version})`, async (t) => {
    const { config, data, store } = await fixture(t, {
      version,
      providers: [
        { ...provider, id: "native", protocol: "anthropic" },
        { ...provider, protocol: "messages" },
        { ...provider, id: "implicit" },
        ...providerPresets.map(({ id }) => ({
          ...provider,
          id,
          protocol: "messages",
        })),
      ],
    });
    const expected = {
      ...data,
      version: 2,
      providers: data.providers.map((row) => ({
        ...row,
        protocol:
          row.id === "custom" || row.id === "implicit"
            ? "messages_compatible"
            : "messages",
      })),
    };
    const [backends, providers] = await Promise.all([
      store.read(),
      store.readProviders(),
    ]);
    assert.equal(backends.version, 2);
    assert.deepEqual(providers, expected.providers);
    const bytes = await readFile(config.backendsFile, "utf8");
    const migrated = await stat(config.backendsFile);
    assert.deepEqual(JSON.parse(bytes), expected);
    assert.equal(migrated.mode & 0o777, 0o600);

    const restarted = createProviders(createBackendConfiguration(config));
    for (const { id, protocol } of expected.providers)
      assert.equal((await restarted.get("claude", id)).protocol, protocol);
    assert.equal(await readFile(config.backendsFile, "utf8"), bytes);
    assert.equal((await stat(config.backendsFile)).ino, migrated.ino);
  });
}

test("当前版本的两种协议保持原值且读取不写盘", async (t) => {
  const { config, data, original, store } = await fixture(t, {
    version: 2,
    providers: [
      { ...provider, protocol: "messages" },
      { ...provider, id: "compatible", protocol: "messages_compatible" },
    ],
  });
  const before = await stat(config.backendsFile);
  assert.deepEqual(await store.readProviders(), data.providers);
  assert.equal(await readFile(config.backendsFile, "utf8"), original);
  assert.equal((await stat(config.backendsFile)).ino, before.ino);
});

for (const [version, invalid] of [
  [1, "unsupported"],
  [2, "unsupported"],
  [2, "anthropic"],
  [2, ""],
  [2, null],
]) {
  test(`拒绝无效的供应商协议且保留原文件 (version=${version}, protocol=${JSON.stringify(invalid)})`, async (t) => {
    const { config, original, store } = await fixture(t, {
      version,
      providers: [
        { ...provider, protocol: "messages" },
        { ...provider, id: "deepseek", protocol: invalid },
      ],
    });
    await assert.rejects(store.read(), /API 协议/);
    await assert.rejects(
      store.update((data) => data),
      /API 协议/,
    );
    assert.equal(await readFile(config.backendsFile, "utf8"), original);
  });
}

test("旧协议与未知协议在保存接口被拒绝", async (t) => {
  const { config, original, store } = await fixture(t, { version: 2 });
  const providers = createProviders(store);
  for (const protocol of ["anthropic", "unsupported"]) {
    await assert.rejects(providers.save({ ...provider, protocol }), /API 协议/);
    await assert.rejects(
      providers.save({ ...provider, id: "deepseek", protocol }),
      /API 协议/,
    );
  }
  assert.equal(await readFile(config.backendsFile, "utf8"), original);
});

test("迁移写盘失败时保留原文件并允许重试", async (t) => {
  if (process.getuid() === 0) return t.skip("权限拒绝场景需要非 root 用户");
  const { config, original, store } = await fixture(t, {
    providers: [{ ...provider, protocol: "messages" }],
  });
  await chmod(config.configDir, 0o500);
  try {
    await assert.rejects(store.read(), /EACCES/);
    assert.equal(await readFile(config.backendsFile, "utf8"), original);
  } finally {
    await chmod(config.configDir, 0o700);
  }
  assert.equal(
    (await store.readProviders())[0].protocol,
    "messages_compatible",
  );
});

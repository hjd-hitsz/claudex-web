import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodexAccountSource } from "../src/backends/opencode/codex-account.mjs";
import { createCodexSubscription } from "../src/backends/opencode/codex-subscription.mjs";

test("Codex 登录态读取合并并发，换号与退出清除旧访问令牌", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-account-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let reads = 0;
  let account = {
    accountID: "first",
    access: "isolated-access",
    expires: Date.now() + 3600000,
    models: ["gpt-test"],
  };
  const source = createCodexAccountSource({
    codexHome: directory,
    read: async () => {
      reads++;
      return account;
    },
  });
  t.after(source.close);
  const result = await Promise.all([source.read(), source.read()]);
  assert.equal(reads, 1);
  assert.equal(result[0], result[1]);
  await source.read();
  assert.equal(reads, 1);
  account = { ...account, accountID: "second", access: "second-access" };
  await writeFile(join(directory, "auth.json"), "isolated metadata");
  assert.equal((await source.read()).accountID, "second");
  assert.equal(reads, 2);
  account = null;
  await writeFile(join(directory, "auth.json"), "logged out");
  assert.equal(await source.read(), null);
  assert.equal(reads, 3);
});

test("OpenCode 订阅仅向 Codex 地址注入当前令牌，退出后停止请求并隐藏模型", async () => {
  let account = {
    accountID: "test-account",
    access: "isolated-access",
    models: ["gpt-test"],
  };
  const transforms = {},
    hooks = new Map();
  let reloads = 0;
  const subscription = createCodexSubscription({
    read: async () => account,
    close() {},
  });
  await subscription.sync();
  const cleanup = await subscription.plugin.setup({
    provider: {
      transform: async (fn) => {
        transforms.provider = fn;
      },
      reload: async () => {
        reloads++;
      },
    },
    model: {
      transform: async (fn) => {
        transforms.model = fn;
      },
    },
    session: {
      hook: async (name, fn) => {
        hooks.set(name, fn);
      },
    },
  });
  const provider = { id: "openai", settings: {} };
  transforms.provider({ get: () => provider, update: (_, fn) => fn(provider) });
  assert.equal(provider.integrationID, "claudex-codex");
  assert.equal(provider.activation, "enabled");
  assert.equal(JSON.stringify(provider).includes("isolated-access"), false);
  const model = { id: "gpt-test", modelID: "gpt-test" };
  transforms.model({ list: () => [model], update: (_, id, fn) => fn(model) });
  assert.equal(model.enabled, true);
  const request = new Request(
    "https://chatgpt.com/backend-api/codex/responses",
  );
  await hooks.get("http.request")({ request, sessionID: "fixture" });
  assert.equal(request.headers.get("authorization"), "Bearer isolated-access");
  assert.equal(request.headers.get("chatgpt-account-id"), "test-account");
  await assert.rejects(
    hooks.get("http.request")({
      request: new Request("https://example.org/responses"),
      sessionID: "fixture",
    }),
    /地址无效/,
  );
  account = null;
  await subscription.sync();
  assert.equal(reloads, 1);
  transforms.model({ list: () => [model], update: (_, id, fn) => fn(model) });
  assert.equal(model.enabled, false);
  await assert.rejects(
    hooks.get("http.request")({ request, sessionID: "fixture" }),
    /Codex 后端登录/,
  );
  cleanup();
});

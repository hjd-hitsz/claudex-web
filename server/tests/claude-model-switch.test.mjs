import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createClaudeRuntime } from "../src/backends/claude/runtime.mjs";
import { createStorage } from "../src/backends/storage.mjs";
import { createCompactions } from "../src/compaction.mjs";

test("模型切换设置失败时保留会话，重试在提交输入前同步所有别名", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-switch-retry-"));
  const provider = { id: "fixture", models: ["first", "second"] };
  const storage = createStorage(join(directory, "state.json"), {
    sessions: {
      thread: {
        id: "thread",
        cwd: directory,
        providerId: provider.id,
        model: "first",
        queue: [],
        turns: {},
      },
    },
  });
  const events = [];
  const inputs = [];
  const calls = [];
  let fail = true;
  const query = {
    async setPermissionMode() {},
    async getHooksListing() {
      return { hooks: [] };
    },
    async setModel(model) {
      calls.push({ operation: "model", model });
    },
    async applyFlagSettings(settings) {
      calls.push({ operation: "settings", settings });
      if (fail) throw new Error("Fixture settings update failed");
    },
    async interrupt() {
      return { cancelled: inputs.map((input) => input.uuid) };
    },
  };
  const runtime = createClaudeRuntime({
    backend: { id: "claude", dataDir: directory },
    storage,
    providers: { get: async () => provider },
    broadcast: (event) => events.push(event),
    compactions: createCompactions(() => {}),
    questions: new Map(),
  });
  const process = {
    query,
    cwd: directory,
    nativeSessionId: "thread",
    providerKey: JSON.stringify(provider),
    model: "first",
    review: false,
    input: { push: (input) => inputs.push(input) },
    close() {},
  };
  runtime.queries.set("thread", process);
  async function until(predicate) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert(Date.now() < deadline, "模型切换应完成状态更新");
      await delay(10);
    }
  }
  try {
    const first = await runtime.enqueue("thread", {
      model: "second",
      input: [{ type: "text", text: "Switch model" }],
    });
    await until(() =>
      events.some(
        (event) =>
          event.method === "turn/completed" &&
          event.params.turn.id === first.turn.id,
      ),
    );
    const failed = events.find((event) => event.method === "turn/completed");
    assert.equal(failed.params.turn.status, "failed");
    assert.match(
      failed.params.turn.error.message,
      /Fixture settings update failed/,
    );
    assert.equal(inputs.length, 0);
    assert.equal(runtime.queries.get("thread"), process);
    await delay(0);
    fail = false;
    await runtime.enqueue("thread", {
      model: "second",
      input: [{ type: "text", text: "Retry switch" }],
    });
    await until(() => inputs.length === 1);
    assert.equal(calls.filter((call) => call.operation === "model").length, 1);
    const settings = calls.filter((call) => call.operation === "settings");
    assert.equal(settings.length, 2);
    for (const call of settings)
      for (const name of [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      ])
        assert.equal(call.settings.env[name], "second");
    assert.equal(inputs[0].message.content[0].text, "Retry switch");
    assert.equal(runtime.queries.get("thread").query, query);
    await runtime.interrupt("thread");
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

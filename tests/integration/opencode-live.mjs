import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadOpenCode } from "../../server/src/backends/opencode/runtime.mjs";
import { once, EventEmitter } from "node:events";
import { createOpenCodeAdapter } from "../../server/src/backends/opencode/adapter.mjs";
assert.ok(process.env.OPENCODE_SDK_ENTRY);
const model = process.env.OPENCODE_LIVE_MODEL || "gpt-6-luna";
const serviceTier = process.env.OPENCODE_LIVE_SERVICE_TIER || null;
const root = await mkdtemp(join(tmpdir(), "opencode-live-"));
Object.assign(process.env, {
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
});
const OpenCode = await loadOpenCode(resolve(process.env.OPENCODE_SDK_ENTRY));
const bus = new EventEmitter();
const events = [];
const requests = [];
const adapter = createOpenCodeAdapter({
  backend: {
    id: "opencode",
    type: "opencode",
    stateDir: join(root, "web-state"),
  },
  config: {
    configDir: join(root, "web"),
    codexHome:
      process.env.CODEX_VALIDATION_HOME ||
      process.env.CODEX_HOME ||
      join(process.env.HOME, ".codex"),
    defaultCwd: root,
    projectlessRoot: join(root, "workspaces"),
  },
  providers: {
    list: async () => [],
    get: async () => null,
  },
  createHost: async (options) => {
    const configuration = JSON.parse(
      await readFile(options.config.file, "utf8"),
    );
    configuration.providers.openai = { settings: { transport: "http" } };
    await writeFile(options.config.file, JSON.stringify(configuration), {
      mode: 0o600,
    });
    const host = await OpenCode.create({
      ...options,
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        const request = {
          url: url.origin + url.pathname,
          startedAt: Date.now(),
        };
        requests.push(request);
        try {
          const response = await fetch(input, init);
          request.status = response.status;
          return response;
        } catch (error) {
          request.error = error.message;
          request.cause = error.cause?.code;
          throw error;
        } finally {
          request.finishedAt = Date.now();
        }
      },
      database: { path: join(root, "opencode.db") },
      config: {
        ...options.config,
        claude: false,
        directory: join(root, "config"),
      },
      models: { fetch: false },
      fs: { filewatcher: false },
    });
    assert.deepEqual(await host.credential.list(), []);
    return host;
  },
  send: (client, message) => client.deliver(message),
  broadcast: (event) => {
    events.push(event);
    bus.emit(event.method, event);
  },
});
let sequence = 0;
async function call(method, params = {}) {
  let response;
  await adapter.receive(
    {
      deliver: (m) => {
        response = m;
      },
    },
    { id: ++sequence, method, params },
  );
  if (response.error) throw new Error(response.error.message);
  return response.result;
}
try {
  await writeFile(
    join(root, "AGENTS.md"),
    "Only operate on the temporary validation.txt file.\n",
  );
  await adapter.connect();
  const choices = (await call("model/list", { cwd: root })).data;
  const selected = choices.find((m) => m.model === `openai/${model}`);
  assert.ok(
    selected,
    "Available subscription models: " +
      choices
        .filter((m) => m.model.startsWith("openai/"))
        .map((m) => m.model)
        .join(", "),
  );
  const { thread } = await call("thread/start", {
    cwd: root,
    model: selected.model,
    serviceTier,
  });
  const finished = once(bus, "turn/completed", {
    signal: AbortSignal.timeout(180000),
  });
  await call("turn/start", {
    threadId: thread.id,
    model: selected.model,
    effort: "low",
    serviceTier,
    input: [
      {
        type: "text",
        text: "在当前临时工作目录创建 validation.txt，内容严格为 opencode-live-ok，然后使用 read 工具核对。保持其他文件不变，完成后简短回答。",
      },
    ],
  });
  const [done] = await finished;
  assert.equal(
    done.params.turn.status,
    "completed",
    JSON.stringify(done.params.turn.error),
  );
  assert.equal(
    (await readFile(join(root, "validation.txt"), "utf8")).trim(),
    "opencode-live-ok",
  );
  const history = (
    await call("thread/read", { threadId: thread.id, includeTurns: true })
  ).thread;
  assert.equal(history.model, selected.model);
  assert.equal(history.reasoningEffort, "low");
  assert.equal(history.serviceTier, serviceTier);
  const items = history.turns.flatMap((t) => t.items);
  assert.ok(
    items.some(
      (i) =>
        i.status === "completed" &&
        (["write", "patch"].includes(i.tool) ||
          (i.type === "commandExecution" &&
            i.command?.includes("validation.txt"))),
    ),
  );
  assert.ok(items.some((i) => i.tool === "read" && i.status === "completed"));
  assert.ok(history.tokenUsage.total.totalTokens > 0);
  assert.ok(history.tokenUsage.last.totalTokens > 0);
  const identity = (await call("account/read", { threadId: thread.id }))
    .account;
  assert.equal(identity.type, "chatgpt");
  await mkdir(".cache/opencode", { recursive: true });
  await writeFile(
    ".cache/opencode/subscription-live.json",
    JSON.stringify(
      {
        sdk: "2.3.2",
        provider: "ChatGPT subscription",
        model,
        serviceTier,
        tools: items
          .filter((i) => i.tool)
          .map((i) => ({ name: i.tool, status: i.status })),
        tokenUsage: history.tokenUsage,
        result: "passed",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      provider: "ChatGPT subscription",
      model,
      serviceTier,
      result: "passed",
    }),
  );
} finally {
  await mkdir(".cache/opencode", { recursive: true });
  await writeFile(
    ".cache/opencode/subscription-events.json",
    JSON.stringify(events, null, 2),
  );
  await writeFile(
    ".cache/opencode/subscription-live-requests.json",
    JSON.stringify(requests, null, 2),
  );
  await adapter.close();
  await rm(root, { recursive: true, force: true });
}

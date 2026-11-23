import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { createOpenCodeAdapter } from "../../server/src/backends/opencode/adapter.mjs";
import { loadOpenCode } from "../../server/src/backends/opencode/runtime.mjs";

assert.ok(process.env.OPENCODE_SDK_ENTRY);
const root = await mkdtemp(join(tmpdir(), "opencode-subscription-"));
Object.assign(process.env, {
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
});
const OpenCode = await loadOpenCode(resolve(process.env.OPENCODE_SDK_ENTRY), {
  workspaceTools: true,
});
const model = "gpt-6.1-sol";
const record = {
  model,
  displayName: "GPT-6.1 Sol",
  inputModalities: ["text", "image"],
  supportedReasoningEfforts: ["low", "high", "ultra"].map(
    (reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }),
  ),
  defaultReasoningEffort: "low",
  serviceTiers: [
    { id: "priority", name: "Fast" },
    { id: "ultrafast", name: "Ultrafast" },
  ],
};
const requests = [],
  events = [],
  searches = [];
const query = "Isolated search for Node.js release notes";
const citation = "https://nodejs.org/en/about/previous-releases";
let host,
  sequence = 0;
const adapter = createOpenCodeAdapter({
  backend: {
    id: "opencode",
    type: "opencode",
    stateDir: join(root, "web"),
    workspaceTools: true,
  },
  config: { configDir: join(root, "web"), codexHome: root, defaultCwd: root },
  providers: { list: async () => [], get: async () => null },
  readCodexAccount: async () => ({
    accountID: "isolated-account",
    access: "isolated-token",
    expires: Date.now() + 3600000,
    models: [model, "gpt-fixture-new"],
    modelCatalogue: [record, { ...record, model: "gpt-fixture-new" }],
  }),
  async fetchCodexSearch(url, options) {
    assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(options.headers.authorization, "Bearer isolated-token");
    assert.equal(options.headers["chatgpt-account-id"], "isolated-account");
    assert.equal(options.redirect, "error");
    const body = JSON.parse(options.body);
    searches.push(body);
    const output = [
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query },
      },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "Release documentation",
            annotations: [
              {
                type: "url_citation",
                title: "Node.js releases",
                url: citation,
              },
            ],
          },
        ],
      },
    ];
    const event = JSON.stringify({
      type: "response.completed",
      response: { output },
    });
    return new Response(`data: ${event}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  },
  send: (client, message) => client.deliver(message),
  broadcast: (event) => events.push(event),
  createHost: async (options) =>
    (host = await OpenCode.create({
      ...options,
      database: { path: join(root, "opencode.db") },
      config: {
        ...options.config,
        claude: false,
        directory: join(root, "config"),
      },
      models: { fetch: false },
      fs: { filewatcher: false },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        assert.equal(
          request.url,
          "https://chatgpt.com/backend-api/codex/responses",
        );
        assert.equal(
          request.headers.get("authorization"),
          "Bearer isolated-token",
        );
        let bytes = Buffer.from(await request.arrayBuffer());
        if (request.headers.get("content-encoding") === "zstd")
          bytes = zstdDecompressSync(bytes);
        const body = JSON.parse(bytes);
        requests.push(body);
        const search =
          body.tools?.some(({ name }) => name === "claudex_web_search") &&
          body.input.some(({ content }) =>
            content?.some?.(({ text }) => text === query),
          ) &&
          !body.input.some(({ type }) => type === "function_call_output");
        const item = search
          ? {
              id: "fc_search",
              type: "function_call",
              call_id: "call_search",
              name: "claudex_web_search",
              arguments: JSON.stringify({ query }),
              status: "completed",
            }
          : {
              id: `msg_${requests.length}`,
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "subscription settings verified",
                  annotations: [],
                },
              ],
            };
        const response = {
          id: `resp_${requests.length}`,
          object: "response",
          created_at: 1,
          status: "completed",
          model: body.model,
          output: [item],
          usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
        };
        const stream = [
          {
            type: "response.created",
            response: { ...response, status: "in_progress", output: [] },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: search
              ? { ...item, arguments: "", status: "in_progress" }
              : { ...item, status: "in_progress", content: [] },
          },
          search
            ? {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: item.id,
                delta: item.arguments,
              }
            : {
                type: "response.output_text.delta",
                output_index: 0,
                content_index: 0,
                item_id: item.id,
                delta: "subscription settings verified",
              },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("");
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    })),
});
async function call(method, params = {}) {
  let response;
  await adapter.receive(
    { deliver: (message) => (response = message) },
    { id: ++sequence, method, params },
  );
  assert.ok(!response.error, response.error?.message);
  return response.result;
}
try {
  await adapter.connect();
  const { data } = await call("model/list", { cwd: root });
  assert.deepEqual(
    data.map((entry) => entry.model).sort(),
    [`openai/${model}`, "openai/gpt-fixture-new"].sort(),
  );
  assert.deepEqual(
    data.find((entry) => entry.model === `openai/${model}`).serviceTiers,
    record.serviceTiers,
  );
  const { thread } = await call("thread/start", {
    cwd: root,
    model: `openai/${model}`,
  });
  for (const [effort, serviceTier] of [
    ["high", "priority"],
    ["ultra", "ultrafast"],
    ["low", null],
  ]) {
    const start = events.length;
    const result = await call("turn/start", {
      threadId: thread.id,
      model: `openai/${model}`,
      effort,
      serviceTier,
      input: [
        {
          type: "text",
          text: effort === "high" ? query : `Check ${effort} ${serviceTier}`,
        },
      ],
    });
    const deadline = Date.now() + 20000;
    while (
      !events
        .slice(start)
        .some(
          (event) =>
            event.method === "turn/completed" &&
            event.params.turn.id === result.turn.id,
        )
    ) {
      assert.ok(Date.now() < deadline, JSON.stringify(events.slice(start)));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const request = requests.findLast((entry) => entry.tools?.length);
    assert.equal(request.model, model);
    assert.equal(request.reasoning.effort, effort);
    assert.equal(request.service_tier ?? null, serviceTier);
    const restored = await call("thread/resume", { threadId: thread.id });
    assert.equal(restored.model, `openai/${model}`);
    assert.equal(restored.reasoningEffort, effort);
    assert.equal(restored.serviceTier, serviceTier);
    const forked = await call("thread/fork", { threadId: thread.id });
    assert.equal(forked.model, restored.model);
    assert.equal(forked.reasoningEffort, effort);
    assert.equal(forked.serviceTier, serviceTier);
    await call("thread/delete", { threadId: forked.thread.id });
  }
  assert.equal(searches.length, 1);
  assert.equal(searches[0].model, model);
  assert.deepEqual(searches[0].input, [
    { role: "user", content: [{ type: "input_text", text: query }] },
  ]);
  assert.deepEqual(searches[0].tools, [
    {
      type: "web_search",
      external_web_access: true,
      search_context_size: "low",
    },
  ]);
  assert.equal(searches[0].store, false);
  assert.ok(
    requests.some(({ input }) =>
      input.some(
        ({ type, output }) =>
          type === "function_call_output" &&
          JSON.stringify(output).includes(citation),
      ),
    ),
  );
  assert.ok(
    requests.every(
      ({ tools }) => !tools?.some(({ name }) => name === "websearch"),
    ),
  );
  const legacy = await host.sessions.create({
    location: { directory: root },
    model: { providerID: "openai", id: `${model}-fast`, variant: "high" },
  });
  const restored = await call("thread/resume", { threadId: legacy.id });
  assert.equal(restored.model, `openai/${model}`);
  assert.equal(restored.serviceTier, "priority");
  assert.equal(restored.reasoningEffort, "high");
  await mkdir(".cache/opencode", { recursive: true });
  const proof = requests
    .filter((entry) => entry.tools?.length)
    .map(({ model, reasoning, service_tier }) => ({
      model,
      reasoning,
      service_tier,
    }));
  await writeFile(
    ".cache/opencode/subscription-native-requests.json",
    JSON.stringify(proof, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: true,
      sdk: "2.3.2",
      actualModelRequests: 0,
      hostedWebSearch: "isolated Responses request verified",
      requests: proof,
      legacyRestored: true,
    }),
  );
} finally {
  await adapter.close();
  await rm(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createClaudeRuntime } from "../../server/src/backends/claude/runtime.mjs";
import { createStorage } from "../../server/src/backends/storage.mjs";
import { createCompactions } from "../../server/src/compaction.mjs";
import { messagesServer } from "../helpers/claude-messages-server.mjs";

const live = Boolean(process.env.MODEL_BASE_URL);
if (live && !process.env.MODEL_ID) throw new Error("请设置 MODEL_ID");
const output = resolve(
  process.env.VALIDATION_OUTPUT || ".cache/backend-acceptance/model-switch",
);
await mkdir(output, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(tmpdir(), "claude-model-switch-"));
const cwd = join(root, "workspace");
await mkdir(cwd);
const models = ["switch-model-a", "switch-model-b"];
const aliases = live ? ["haiku"] : ["opus", "sonnet", "haiku"];
const requests = [];
const delegated = new Set();
let round = 0;
let forward;
let upstream;
function isChild(request, prefix = "CHILD_SWITCH_") {
  return request.messages?.some(
    (message) =>
      message.role === "user" &&
      message.content?.some?.(
        (block) => block.type === "text" && block.text.startsWith(prefix),
      ),
  );
}
if (live) {
  forward = http.createServer(async (request, response) => {
    try {
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      const entry = { round, ...body };
      requests.push(entry);
      const headers = { ...request.headers };
      delete headers.host;
      delete headers["content-length"];
      delete headers.connection;
      const result = await fetch(process.env.MODEL_BASE_URL + request.url, {
        method: request.method,
        headers,
        body: JSON.stringify({
          ...body,
          model: process.env.MODEL_ID,
          max_tokens: 1024,
          thinking: { type: "disabled" },
        }),
      });
      entry.status = result.status;
      response.writeHead(result.status, {
        "content-type": result.headers.get("content-type"),
      });
      await pipeline(Readable.fromWeb(result.body), response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(502);
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve) => forward.listen(0, "127.0.0.1", resolve));
  upstream = `http://127.0.0.1:${forward.address().port}`;
}
const service = live
  ? null
  : await messagesServer((body) => {
      requests.push({ round, ...body });
      if (isChild(body)) return [{ type: "text", text: "CHILD_SWITCH_OK" }];
      if (body.tools?.some((tool) => tool.name === "Agent")) {
        if (!delegated.has(round)) {
          delegated.add(round);
          return aliases.map((alias) => ({
            type: "tool_use",
            id: `switch-${round}-${alias}`,
            name: "Agent",
            input: {
              description: `Check ${alias} mapping`,
              subagent_type: "general-purpose",
              model: alias,
              run_in_background: false,
              prompt: `CHILD_SWITCH_${round}_${alias}: reply CHILD_SWITCH_OK only.`,
            },
          }));
        }
        return [{ type: "text", text: "MODEL_SWITCH_OK" }];
      }
      return [{ type: "text", text: "Auxiliary result" }];
    });
const provider = {
  id: "switch-fixture",
  baseUrl: upstream || service.url,
  apiKey: process.env.MODEL_API_KEY || "fixture-token",
  protocol: "messages",
  models,
  modelCapabilities: Object.fromEntries(
    models.map((model) => [
      model,
      {
        contextWindow: live ? 65536 : 196608,
        supportsAdaptiveThinking: false,
        supportedEffortLevels: [],
      },
    ]),
  ),
};
const id = randomUUID();
const storage = createStorage(join(root, "index.json"), {
  sessions: {
    [id]: {
      id,
      cwd,
      providerId: provider.id,
      model: models[0],
      turns: {},
      queue: [],
    },
  },
});
const events = [];
const backend = {
  id: "claude",
  executable: process.env.CLAUDE_EXECUTABLE || "claude",
  dataDir: join(root, "native"),
  stateDir: join(root, "web"),
};
const runtime = createClaudeRuntime({
  backend,
  storage,
  providers: { get: async () => provider },
  broadcast: (event) => events.push(event),
  compactions: createCompactions(() => {}),
  questions: new Map(),
});
const report = {
  source: live ? "real-model" : "isolated-messages-fixture",
  upstreamModel: live ? process.env.MODEL_ID : null,
  cli: execFileSync(backend.executable, ["--version"], {
    encoding: "utf8",
  }).trim(),
  rounds: [],
};
try {
  let previous;
  for (const model of [...models, models[0]]) {
    round++;
    const start = requests.length;
    const { turn } = await runtime.enqueue(id, {
      model,
      input: [
        {
          type: "text",
          text: live
            ? `Round ${round}. Use the Agent tool exactly once with model haiku, subagent_type general-purpose and run_in_background false. Its prompt must be "CHILD_SWITCH_${round}_haiku: reply CHILD_SWITCH_OK only." After receiving its answer reply MODEL_SWITCH_OK only. Perform this delegation even if a similar task was done earlier. Do not use other tools.`
            : `MODEL_SWITCH_ROUND_${round}`,
        },
      ],
    });
    const deadline = Date.now() + (live ? 180000 : 30000);
    let completed;
    while (
      !(completed = events.find(
        (event) =>
          event.method === "turn/completed" && event.params.turn.id === turn.id,
      ))
    ) {
      assert(Date.now() < deadline, "模型切换轮次应在期限内完成");
      await delay(25);
    }
    assert.equal(
      completed.params.turn.status,
      "completed",
      JSON.stringify(completed),
    );
    const process = runtime.queries.get(id);
    if (previous) assert.equal(process.query, previous, "切换复用原生会话");
    previous = process.query;
    const current = requests.slice(start);
    const main = current.filter(
      (request) =>
        !isChild(request) &&
        request.tools?.some((tool) => tool.name === "Agent"),
    );
    assert(main.length > 0);
    assert(main.every((request) => request.model === model));
    const children = aliases.map((alias) => {
      const request = current.find((request) =>
        isChild(request, `CHILD_SWITCH_${round}_${alias}`),
      );
      assert(request, `${alias} 子代理应实际发出模型请求`);
      return { alias, model: request.model };
    });
    const result = {
      round,
      model,
      mainModels: main.map((r) => r.model),
      children,
    };
    report.rounds.push(result);
    console.log(JSON.stringify(result));
    assert(
      children.every((child) => child.model === model),
      "子代理别名须跟随当前模型",
    );
    if (live) assert(current.every((request) => request.status === 200));
    const saved = (await storage.read()).sessions[id];
    assert.equal(saved.model, model);
    const updated = events.findLast(
      (event) =>
        event.method === "thread/settings/updated" &&
        event.params.threadId === id,
    );
    assert.equal(updated.params.threadSettings.model, model);
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  throw error;
} finally {
  runtime.close();
  await Promise.allSettled(
    [...runtime.queries.values()].map((run) => run.done),
  );
  await service?.close();
  if (forward) {
    forward.closeAllConnections();
    await new Promise((resolve) => forward.close(resolve));
  }
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await writeFile(
    join(output, "requests.json"),
    JSON.stringify(requests, null, 2) + "\n",
    { mode: 0o600 },
  );
  await rm(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as reservePort } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { createCodexAdapter } from "../../server/src/backends/codex/adapter.mjs";
import { readConfig } from "../../server/src/config.mjs";

const cwd = await mkdtemp(join(tmpdir(), "codex-goal-steering-"));
const firstResponse = Promise.withResolvers();
const requests = [];
const events = [];
const followUp = "FOLLOW_UP_DURING_NATIVE_GOAL";
const fixture = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/responses") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const bytes of req) body += bytes;
  requests.push(JSON.parse(body));
  const n = requests.length;
  if (n === 1) await firstResponse.promise;
  const item = {
    type: "message",
    role: "assistant",
    id: "message_" + n,
    content: [{ type: "output_text", text: "Fixture response" }],
  };
  const response = {
    id: "response_" + n,
    object: "response",
    status: "completed",
    output: [item],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
  };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ])
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
const port = reservePort();
port.listen(0, "127.0.0.1");
await once(port, "listening");
const url = `ws://127.0.0.1:${port.address().port}`;
await new Promise((resolve) => port.close(resolve));
await writeFile(
  join(cwd, "config.toml"),
  `model = "gpt-6.1-sol"
model_provider = "fixture"
thread_unload_delay_secs = 0
[model_providers.fixture]
name = "Fixture"
base_url = "http://127.0.0.1:${fixture.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
[features]
thread_goals = true
`,
);
const child = spawn(
  process.env.CODEX_EXECUTABLE || "codex",
  ["app-server", "--listen", url],
  {
    env: { ...process.env, CODEX_HOME: cwd },
    stdio: ["ignore", "ignore", "pipe"],
  },
);
child.stderr.resume();
let adapter;
let sequence = 0;
const pending = new Map();
const client = { readyState: WebSocket.OPEN };
async function until(read, description) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  assert.fail(description);
}
try {
  await until(
    () =>
      new Promise((resolve) => {
        const socket = new WebSocket(url);
        socket.once("open", () => {
          socket.close();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      }),
    "等待原生 app-server 监听",
  );
  adapter = createCodexAdapter({
    backend: { url, dataDir: cwd },
    config: readConfig({
      CODEX_HOME: cwd,
      CLAUDEX_WEB_CONFIG_DIR: join(cwd, "web"),
    }),
    version: { displayVersion: "goal-steering" },
    send(_, message) {
      const request = pending.get(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    },
    broadcast: (message) => events.push(message),
  });
  adapter.connect();
  await until(() => adapter.ready, "等待桥接连接");
  async function call(method, params) {
    const id = ++sequence;
    const response = Promise.withResolvers();
    pending.set(id, response);
    const timer = setTimeout(() => response.reject(new Error(method)), 8000);
    try {
      await adapter.receive(client, { id, method, params });
      return await response.promise;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }
  const { thread } = await call("thread/start", { cwd });
  const threadId = thread.id;
  await call("thread/name/set", { threadId, name: "Goal steering fixture" });
  const { goal } = await call("thread/goal/set", {
    threadId,
    objective: "Continue until the supplied fixture work is finished",
    status: "active",
    origin: "user",
    tokenBudget: 480,
  });
  assert.equal(goal.status, "active");
  const activeTurn = () => adapter.state().params.activeTurns[threadId];
  const expectedTurnId = await until(activeTurn, "等待目标轮次开始");
  await until(() => requests.length, "等待首个目标模型请求");
  const input = [{ type: "text", text: followUp }];
  assert.equal(
    (await call("turn/steer", { threadId, expectedTurnId, input })).turnId,
    expectedTurnId,
  );
  adapter.releaseClient(client);
  firstResponse.resolve();
  await until(
    () =>
      requests.some((request) =>
        request.input.some(
          (item) =>
            item.role === "user" &&
            item.content?.some((part) => part.text === followUp),
        ),
      ),
    "目标续跑需要将已确认的中途消息送入模型请求",
  );
  await until(
    () => events.some((event) => event.method === "thread/closed"),
    "目标到达预算上限后释放闲置订阅",
  );
  assert.equal(
    (await call("thread/goal/get", { threadId })).goal.status,
    "budgetLimited",
  );
  console.log("Codex goal steering reached the model across native turns");
} finally {
  firstResponse.resolve();
  adapter?.close();
  if (child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  await rm(cwd, { recursive: true, force: true });
}

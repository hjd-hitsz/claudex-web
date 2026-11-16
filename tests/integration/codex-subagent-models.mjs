import http from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { subagentModelParams } from "../../server/src/backends/codex/subagent-model.mjs";
const root = await mkdtemp(join(tmpdir(), "codex-subagent-native-"));
const requests = [];
let sequence = 0;
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  requests.push(input);
  console.log(JSON.stringify({ model: input.model }));
  const parent = input.model === "gpt-6.1-sol";
  const already = JSON.stringify(input.input).includes("spawn-proof");
  const item =
    parent && !already
      ? {
          type: "function_call",
          id: "fc_spawn",
          call_id: "spawn-proof",
          name: "spawn_agent",
          namespace: "collaboration",
          arguments: JSON.stringify({
            task_name: "proof",
            fork_turns: "none",
            message: "CHILD_NATIVE_MODEL_PROOF",
          }),
        }
      : {
          type: "message",
          id: "message_" + sequence,
          role: "assistant",
          content: [{ type: "output_text", text: "MODEL_PROOF_COMPLETE" }],
        };
  const response = {
    id: "resp_" + ++sequence,
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
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await writeFile(
  join(root, "config.toml"),
  `model = "gpt-6.1-sol"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
);
const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
  env: { ...process.env, CODEX_HOME: root },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));
const pending = new Map();
let seq = 0;
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const p = pending.get(message.id);
  if (p) {
    pending.delete(message.id);
    clearTimeout(p.timer);
    message.error
      ? p.reject(new Error(JSON.stringify(message.error)))
      : p.resolve(message.result);
  }
});
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(
      () => reject(new Error(method + " timeout " + stderr)),
      20000,
    );
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
try {
  await call("initialize", {
    clientInfo: { name: "subagent_probe", version: "1" },
    capabilities: { experimentalApi: true },
  });
  const started = await call(
    "thread/start",
    subagentModelParams(
      "thread/start",
      {
        cwd: root,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        config: { "agents.enabled": true },
      },
      { subagentModel: "gpt-6-luna", subagentEffort: "high" },
    ),
  );
  await call("turn/start", {
    threadId: started.thread.id,
    input: [{ type: "text", text: "Delegate a child task." }],
  });
  for (
    let i = 0;
    i < 400 && !requests.some((r) => r.model === "gpt-6-luna");
    i++
  )
    await delay(50);
  assert.ok(
    requests.some((r) => r.model === "gpt-6-luna"),
    JSON.stringify({ requests, stderr }),
  );
  assert.equal(
    requests.find((request) => request.model === "gpt-6-luna").reasoning
      ?.effort,
    "high",
  );
  console.log("PASS native Codex child model");
} finally {
  for (const p of pending.values()) clearTimeout(p.timer);
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

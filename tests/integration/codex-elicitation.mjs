import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createCodexAdapter } from "../../server/src/backends/codex/adapter.mjs";
import { readConfig } from "../../server/src/config.mjs";

const executable = process.env.CODEX_EXECUTABLE || "codex";
const home = await mkdtemp(join(tmpdir(), "codex-elicitation-"));
const fixture = fileURLToPath(
  new URL("../helpers/codex-elicitation-mcp.mjs", import.meta.url),
);
await writeFile(
  join(home, "config.toml"),
  `[mcp_servers.approval_audit]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fixture)}]\n`,
);
const reserve = createServer();
reserve.listen(0, "127.0.0.1");
await once(reserve, "listening");
const url = "ws://127.0.0.1:" + reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const cli = spawn(executable, ["app-server", "--listen", url], {
  env: { ...process.env, CODEX_HOME: home },
  stdio: ["ignore", "ignore", "pipe"],
});
const exit = once(cli, "exit");
cli.stderr.resume();
const events = new EventEmitter();
const client = { readyState: 1 };
let sequence = 0;
const adapter = createCodexAdapter({
  backend: { url, dataDir: home },
  config: readConfig({
    CODEX_HOME: home,
    CLAUDEX_WEB_CONFIG_DIR: join(home, "web"),
  }),
  version: { displayVersion: "fixture" },
  broadcast(message) {
    if (message.method === "mcpServer/elicitation/request")
      events.emit("elicitation", message);
  },
  send(_client, message) {
    events.emit("reply:" + message.id, message);
  },
});
const deadline = () => ({ signal: AbortSignal.timeout(12000) });
async function call(method, params) {
  const id = ++sequence;
  const reply = once(events, "reply:" + id, deadline());
  await adapter.receive(client, { id, method, params });
  const [message] = await reply;
  assert.equal(message.error, undefined);
  return message.result;
}
async function thread(approvalPolicy) {
  return call("thread/start", {
    cwd: home,
    model: "fixture-model",
    approvalPolicy,
    sandbox: "danger-full-access",
  });
}
async function invoke(threadId, kind, response) {
  const request = once(events, "elicitation", deadline());
  const reply = call("mcpServer/tool/call", {
    threadId,
    server: "approval_audit",
    tool: "confirm",
    arguments: { kind },
  });
  await Promise.race([
    request,
    reply.then(() => {
      throw new Error("原生工具未请求交互");
    }),
  ]);
  const [message] = await request;
  assert.equal(message.params.mode, kind);
  if (kind === "url")
    assert.equal(message.params.url, "https://example.invalid/approval");
  else
    assert.equal(
      message.params.requestedSchema.properties.confirm.type,
      "boolean",
    );
  const { threads } = await adapter.conversationManager.observeThreads();
  assert.equal(
    threads.find((entry) => entry.threadId === threadId)?.status,
    "waitingForInput",
  );
  await adapter.receive(client, { id: message.id, result: response });
  const result = JSON.parse((await reply).content[0].text);
  assert.deepEqual(
    result,
    kind === "url" && response.action === "accept"
      ? { ...response, content: {} }
      : response,
  );
}
try {
  adapter.connect();
  for (let count = 0; !adapter.ready && count < 120; count++) await delay(100);
  assert.equal(adapter.ready, true);
  const fullAccess = await thread("never");
  assert.equal(fullAccess.thread.threadSource, "user");
  assert.equal(fullAccess.approvalPolicy, "never");
  assert.equal(fullAccess.sandbox.type, "dangerFullAccess");
  await invoke(fullAccess.thread.id, "form", {
    action: "accept",
    content: { confirm: false },
  });
  await invoke(fullAccess.thread.id, "form", { action: "decline" });
  const eligible = await thread("on-request");
  await invoke(eligible.thread.id, "url", { action: "accept" });
  await invoke(eligible.thread.id, "url", { action: "decline" });
  console.log(
    execFileSync(executable, ["--version"], { encoding: "utf8" }).trim(),
  );
  console.log(
    "PASS 原生 MCP 表单与 URL 各完成接受/拒绝回传，交互期间为 waitingForInput",
  );
} finally {
  adapter.close();
  cli.kill();
  await exit;
  await rm(home, { recursive: true, force: true });
}

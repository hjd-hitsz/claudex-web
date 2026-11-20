import { backgroundTerminalBrowser } from "../helpers/background-terminal-browser.mjs";
import { received } from "../../packages/background-terminal/delivery.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { authenticationFixture } from "../helpers/auth.mjs";
import { taskRequest } from "../../packages/background-terminal/client.mjs";

// 真实 Codex app-server 与本地 Responses 服务验证 MCP、卸载和自动续跑。
// 所有会话、任务及模型请求均留在临时目录和本机回环地址。
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "codex-web-real-background-"));
const codexHome = join(directory, "codex-home");
const workspace = join(directory, "workspace");
await mkdir(codexHome);
await mkdir(workspace);
await writeFile(
  join(workspace, "background.test.cjs"),
  `
const { test } = require("node:test");
const assert = require("node:assert/strict");
test("解析任务配置", () => assert.equal(JSON.parse('{"enabled":true}').enabled, true));
test("保留终端 Unicode 输出", () => assert.equal(Buffer.from("后台终端").toString(), "后台终端"));
`,
);
const binary = process.env.CODEX_BINARY || "codex";
const version = execFileSync(binary, ["--version"], {
  encoding: "utf8",
}).trim();
const calls = [],
  events = [],
  sockets = [],
  children = [];
let phase = "seed",
  jobRequests = 0;
const nativeRequests = new Map();
const inference = http.createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push({ phase, inputTypes: body.input?.map((item) => item.type) });
    const nativeMode =
      /native-terminal-fixture-(enabled|disabled|cancelled)/.exec(
        JSON.stringify(body.input),
      )?.[1];
    let item;
    if (nativeMode) {
      const count = (nativeRequests.get(nativeMode) ?? 0) + 1;
      nativeRequests.set(nativeMode, count);
      if (count === 1) {
        const tool = body.tools
          .flatMap(
            (entry) =>
              entry.tools?.map((child) => ({
                ...child,
                namespace: entry.name,
              })) || [entry],
          )
          .find((entry) => entry.name === "exec_command");
        assert(tool, "模型应保留原生 exec_command");
        const script = [
          'const fs = require("node:fs")',
          `fs.appendFileSync("native-${nativeMode}.pid", process.pid + "\\n")`,
          'console.log("start",process.pid)',
          'const timer = setInterval(() => { if (!fs.existsSync("release-fixture")) return',
          'clearInterval(timer); console.log("end",process.pid); console.error("native stderr"); process.exitCode = 23 }, 30)',
        ].join(";");
        item = {
          type: "function_call",
          name: tool.name,
          namespace: tool.namespace,
          call_id: "native-terminal-" + nativeMode,
          arguments: JSON.stringify({
            cmd: `"${process.execPath}" -e '${script}'`,
            yield_time_ms: 1000,
            login: false,
          }),
        };
      } else {
        if (count === 3) {
          assert.equal(nativeMode, "enabled");
          const output = body.input.find(
            (entry) => entry.name === "background_completed",
          );
          assert(output, "原生终端结果应触发新轮次");
          const [result] = JSON.parse(output.output).results;
          assert.equal(result.exit_code, 23);
          assert.ok(result.native_session_id);
          assert.match(
            result.output_tail,
            /start (\d+)\nend \1\nnative stderr/,
          );
        } else {
          assert.equal(count, 2);
          assert(
            body.input.some(
              (entry) =>
                entry.type === "function_call_output" &&
                JSON.stringify(entry).includes(
                  "Process running with session ID",
                ),
            ),
          );
        }
        item = {
          type: "message",
          id: "native-message-" + calls.length,
          role: "assistant",
          content: [{ type: "output_text", text: "原生终端验证" }],
        };
      }
    } else if (phase === "job" && ++jobRequests === 1) {
      const tool = body.tools
        .flatMap(
          (entry) =>
            entry.tools?.map((child) => ({
              ...child,
              namespace: entry.name,
            })) || [entry],
        )
        .find((entry) => entry.name === "background_start");
      assert(tool, "恢复旧对话后应向模型暴露 MCP 工具");
      assert.match(tool.description, /原生 exec_command 达到前台等待上限/);
      assert.match(tool.description, /无需轮询、调用 sleep/);
      const script =
        'const timer=setInterval(()=>{if(require("fs").existsSync("release-fixture"))clearInterval(timer)},50)';
      item = {
        type: "function_call",
        name: tool.name,
        namespace: tool.namespace,
        call_id: "background-real-call",
        arguments: JSON.stringify({
          command: [
            `npm --prefix "${root}" run architecture:check`,
            `"${process.execPath}" -e 'process.emitWarning("回归验证标准错误输出")'`,
            `"${process.execPath}" -e '${script}'`,
            `"${process.execPath}" --test --test-reporter=tap background.test.cjs`,
          ].join(" && "),
          title: "项目架构检查与测试",
        }),
      };
    } else {
      if (phase === "job" && jobRequests === 3)
        assert(
          body.input.some(
            (entry) =>
              entry.type === "function_call_output" &&
              JSON.stringify(entry).includes("# pass 2"),
          ),
          "自动续跑应携带任务完成结果",
        );
      item = {
        type: "message",
        id: "message-" + calls.length,
        role: "assistant",
        content: [
          {
            type: "output_text",
            text:
              phase === "seed"
                ? "历史对话已建立。"
                : jobRequests === 2
                  ? "后台任务已启动，当前轮次结束。"
                  : "已收到后台结果并继续处理。",
          },
        ],
      };
    }
    const id = "local-response-" + calls.length;
    const stream = [
      { type: "response.created", response: { id } },
      { type: "response.output_item.done", item },
      {
        type: "response.completed",
        response: {
          id,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      stream
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
    );
  } catch (error) {
    diagnostics += "\n模拟模型响应失败：" + error.message;
    response.writeHead(500).end(error.message);
  }
});
await new Promise((resolve) => inference.listen(0, "127.0.0.1", resolve));
const reserve = http.createServer();
await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `ws://127.0.0.1:${reserve.address().port}`;
await new Promise((resolve) => reserve.close(resolve));
await writeFile(
  join(codexHome, "config.toml"),
  `model = "gpt-5.4"
model_provider = "fixture"
thread_unload_delay_secs = 0
project_doc_max_bytes = 0
web_search = "disabled"
[features]
apps = false
plugins = false
multi_agent = false
hooks = false
memories = false
goals = true
shell_snapshot = false
code_mode = false
code_mode_host = false
code_mode_only = false
enable_request_compression = false
[model_providers.fixture]
name = "Local background protocol fixture"
base_url = "http://127.0.0.1:${inference.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
`,
);
const env = {
  ...process.env,
  CODEX_HOME: codexHome,
  CODEX_APP_SERVER_URL: upstreamUrl,
  CLAUDEX_BACKGROUND_TASKS_DIR: "",
  CLAUDEX_WEB_CONFIG_DIR: join(directory, "web"),
  CLAUDE_CONFIG_DIR: join(directory, "claude"),
  HOST: "127.0.0.1",
  PORT: "0",
};
const state = join(env.CLAUDEX_WEB_CONFIG_DIR, "background-terminal");
let diagnostics = "";
function spawnProcess(command, args) {
  const child = spawn(command, args, {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stderr.on("data", (bytes) => {
    diagnostics = (diagnostics + bytes).slice(-16000);
  });
  return child;
}
async function until(read, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(30);
  }
  throw new Error(
    description +
      "\n" +
      JSON.stringify({
        calls,
        last: events
          .slice(-8)
          .map((e) => [
            e.method,
            e.params?.turn?.status,
            e.params?.turn?.error?.message,
          ]),
      }) +
      "\n" +
      diagnostics,
  );
}
async function connection(url, options) {
  const socket = new WebSocket(url, options);
  socket.on("error", () => {});
  await once(socket, "open");
  sockets.push(socket);
  const pending = new Map();
  let sequence = 0;
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes);
    if (message.method) {
      events.push(message);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error)
      request.reject(
        new Error(
          phase + " " + request.method + ": " + JSON.stringify(message.error),
        ),
      );
    else request.resolve(message.result);
  });
  return {
    socket,
    rpc: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("RPC 超时：" + method));
        }, 30000);
        pending.set(id, { resolve, reject, timer, method });
        socket.send(JSON.stringify({ id, method, params }));
      }),
  };
}
let ui;
const liveBrowser = process.env.BACKGROUND_LIVE_BROWSER === "1";
try {
  const backend = spawnProcess(binary, ["app-server", "--listen", upstreamUrl]);
  const direct = await until(async () => {
    assert.equal(backend.exitCode, null, diagnostics);
    try {
      return await connection(upstreamUrl);
    } catch {
      return null;
    }
  }, "启动真实 app-server");
  await direct.rpc("initialize", {
    clientInfo: { name: "background_fixture", version: "1" },
    capabilities: { experimentalApi: true },
  });
  direct.socket.send(JSON.stringify({ method: "initialized" }));
  const { thread } = await direct.rpc("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    baseInstructions: "Execute the supplied tools for a local protocol test.",
  });
  await direct.rpc("thread/name/set", {
    threadId: thread.id,
    name: "后台协议隔离验证",
  });
  assert(
    !(
      await direct.rpc("mcpServerStatus/list", { threadId: thread.id })
    ).data.some((s) => s.name === "claudex_background"),
  );
  const seed = await direct.rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "建立历史对话。" }],
  });
  await until(
    () =>
      events.some(
        (event) =>
          event.method === "turn/completed" &&
          event.params.turn.id === seed.turn.id,
      ),
    "建立旧对话",
  );
  await direct.rpc("thread/unsubscribe", { threadId: thread.id });
  await until(
    () =>
      events.some(
        (event) =>
          event.method === "thread/closed" &&
          event.params.threadId === thread.id,
      ),
    "卸载旧对话",
  );
  phase = "job";
  spawnProcess(process.execPath, [
    join(root, "packages/background-terminal/cli.mjs"),
    "serve",
    state,
    upstreamUrl,
  ]);
  await until(async () => {
    try {
      return await taskRequest(state, "health");
    } catch {
      return false;
    }
  }, "等待独立任务服务");
  const auth = await authenticationFixture(env.CLAUDEX_WEB_CONFIG_DIR);
  await writeFile(
    join(env.CLAUDEX_WEB_CONFIG_DIR, "backends.json"),
    JSON.stringify({
      version: 1,
      providers: [],
      backends: [
        { type: "codex", id: "codex", enabled: true },
        { type: "claude", id: "claude", enabled: false },
      ],
    }),
  );
  const bridge = spawnProcess(process.execPath, [
    join(root, "server/src/server.mjs"),
  ]);
  let outputText = "";
  bridge.stdout.on("data", (chunk) => {
    outputText += chunk;
  });
  const url = await until(
    () => outputText.match(/https:\/\/127\.0\.0\.1:\d+/)?.[0],
    "启动 HTTPS 桥接",
  );
  const browser = await connection(url.replace("https:", "wss:") + "/rpc", {
    ca: auth.tls.cert,
    headers: { Cookie: auth.cookie, Origin: url },
  });
  await until(
    () => events.some((e) => e.method === "lan/state" && e.params.ready),
    "桥接连接",
  );
  const preference = async (enabled) =>
    (
      await browser.rpc("lan/backends/save", {
        id: "codex",
        type: "codex",
        backgroundTerminalEnabled: enabled,
      })
    ).backends.find((b) => b.id === "codex");
  const config = (await browser.rpc("lan/backends/list")).backends;
  assert.equal(
    config.find((b) => b.id === "codex").backgroundTerminalEnabled,
    false,
  );
  assert.equal(
    config.find((b) => b.id === "claude").backgroundTerminalEnabled,
    undefined,
  );
  const disabled = await browser.rpc("thread/start", {
    cwd: workspace,
    ephemeral: true,
  });
  const tools = async (threadId) =>
    (await browser.rpc("mcpServerStatus/list", { threadId })).data.find(
      (s) => s.name === "claudex_background",
    )?.tools;
  assert.equal(await tools(disabled.thread.id), undefined);
  await browser.rpc("thread/unsubscribe", { threadId: disabled.thread.id });
  const nativeRun = async (mode) => {
    const { thread: native } = await browser.rpc("thread/start", {
      cwd: workspace,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
    await browser.rpc("thread/name/set", {
      threadId: native.id,
      name: "原生后台终端隔离验证",
    });
    const { turn } = await browser.rpc("turn/start", {
      threadId: native.id,
      input: [{ type: "text", text: "native-terminal-fixture-" + mode }],
    });
    await until(
      () =>
        events.some(
          (event) =>
            event.method === "turn/completed" &&
            event.params.turn.id === turn.id,
        ),
      "原生终端所属轮次正常结束",
    );
    const file = join(workspace, `native-${mode}.pid`);
    const pid = Number((await readFile(file, "utf8")).trim());
    assert(Number.isInteger(pid) && pid > 1);
    const jobs = async () =>
      (
        await taskRequest(state, "tool", {
          threadId: native.id,
          name: "background_list",
          args: {},
        })
      ).jobs;
    return { threadId: native.id, jobs, pid, file };
  };
  const disabledNative = await nativeRun("disabled");
  await until(() => {
    try {
      process.kill(disabledNative.pid, 0);
      return false;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return true;
    }
  }, "关闭 MCP 时原生会话按正常生命周期卸载");
  assert.deepEqual(await disabledNative.jobs(), []);
  if (process.env.PLAYWRIGHT_MODULE)
    ui = await backgroundTerminalBrowser(
      url,
      auth.cookie,
      join(root, ".cache/background-codex"),
    );
  else assert.equal((await preference(true)).backgroundTerminalEnabled, true);
  assert.equal(
    JSON.parse(
      await readFile(join(env.CLAUDEX_WEB_CONFIG_DIR, "backends.json"), "utf8"),
    ).backends.find((b) => b.id === "codex").backgroundTerminalEnabled,
    true,
  );
  await browser.rpc("thread/resume", {
    threadId: thread.id,
    excludeTurns: true,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });
  await until(
    async () => Object.keys((await tools(thread.id)) || {}).length === 4,
    "注册四项工具",
  );
  const initial = await browser.rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "启动后台任务并结束本轮。" }],
  });
  await until(
    () =>
      events.some(
        (event) =>
          event.method === "turn/completed" &&
          event.params.turn.id === initial.turn.id,
      ),
    "结束启动任务的轮次",
  );
  const list = () =>
    taskRequest(state, "tool", {
      threadId: thread.id,
      name: "background_list",
      args: {},
    });
  const running = await list();
  assert.equal(running.jobs.length, 1);
  assert.equal(running.jobs[0].threadId, thread.id);
  assert.equal(
    running.jobs[0].status,
    "running",
    "模型结束轮次时任务应仍在运行",
  );
  const terminals = browser.rpc;
  assert(
    (
      await terminals("thread/backgroundTerminals/list", {
        threadId: thread.id,
      })
    ).data.some((t) => t.processId === running.jobs[0].id),
  );
  if (ui) {
    await ui.inspectTask(running.jobs[0].command);
    if (!liveBrowser) {
      await ui.close();
      ui = null;
    }
  }
  const enabledNative = await nativeRun("enabled");
  const nativeJob = await until(async () => {
    const jobs = await enabledNative.jobs();
    return jobs.find((job) => job.status === "running" && job.native);
  }, "开启 MCP 时独立服务接过订阅");
  assert.equal(
    (
      await terminals("thread/backgroundTasks/list", {
        threadId: enabledNative.threadId,
      })
    ).tasks[0].id,
    nativeJob.id,
  );
  const nativeTerminalPage = await terminals(
    "thread/backgroundTerminals/list",
    {
      threadId: enabledNative.threadId,
    },
  );
  assert.deepEqual(
    nativeTerminalPage.data.map((terminal) => terminal.processId),
    [nativeJob.native.processId],
  );
  const cancelledNative = await nativeRun("cancelled");
  await terminals("thread/backgroundTerminals/clean", {
    threadId: cancelledNative.threadId,
  });
  await until(async () => {
    const [job] = await cancelledNative.jobs();
    return job?.delivery === "suppressed" && job.completedAt;
  }, "停止原生终端后不触发续跑");
  if (!liveBrowser) {
    assert.equal((await preference(false)).backgroundTerminalEnabled, false);
    const { thread: other } = await browser.rpc("thread/fork", {
      threadId: thread.id,
      excludeTurns: true,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
    assert.equal(await tools(other.id), undefined);
    const second = await taskRequest(state, "tool", {
      threadId: other.id,
      callId: "cancel-test",
      name: "background_start",
      args: { command: "sleep 120", title: "验证停止" },
    });
    assert(
      (
        await terminals("thread/backgroundTerminals/list", {
          threadId: other.id,
        })
      ).data.some((t) => t.processId === second.job.id),
    );
    const third = await taskRequest(state, "tool", {
      threadId: other.id,
      callId: "cancel-test-neighbour",
      name: "background_start",
      args: { command: "sleep 120", title: "同对话里的另一个任务" },
    });
    await assert.rejects(
      terminals("thread/backgroundTasks/read", {
        threadId: other.id,
        taskId: running.jobs[0].id,
      }),
      /没有此后台任务/,
    );
    await terminals("thread/backgroundTasks/cancel", {
      threadId: other.id,
      taskId: second.job.id,
    });
    assert.deepEqual(
      (
        await terminals("thread/backgroundTasks/list", { threadId: other.id })
      ).tasks.map((task) => task.id),
      [third.job.id],
    );
    await terminals("thread/backgroundTerminals/clean", { threadId: other.id });
    const stopped = await taskRequest(state, "tool", {
      threadId: other.id,
      name: "background_list",
      args: {},
    });
    assert.ok(stopped.jobs.every((job) => job.status === "cancelled"));
    assert.equal((await list()).jobs[0].status, "running");
    browser.socket.close();
    const exit = once(bridge, "exit");
    bridge.kill("SIGTERM");
    await exit;
  }
  process.kill(enabledNative.pid, 0);
  await writeFile(join(workspace, "release-fixture"), "done");
  await until(async () => {
    const jobs = await enabledNative.jobs();
    return jobs.find((job) => job.id === nativeJob.id)?.delivery === "accepted";
  }, "原生终端结束后投递真实结果");
  assert.equal(
    (await readFile(enabledNative.file, "utf8")).trim(),
    String(enabledNative.pid),
    "后台继续的是前台原进程",
  );
  const delivered = await until(async () => {
    const snapshot = await list();
    return snapshot.jobs[0].delivery === "accepted" && snapshot;
  }, "页面关闭后自动提交后台完成结果");
  await until(async () => {
    const page = await direct.rpc("thread/turns/list", {
      threadId: thread.id,
      limit: 100,
      itemsView: "full",
    });
    return page.data.some(
      (turn) =>
        turn.status === "completed" &&
        turn.items?.some(
          (item) =>
            item.type === "agentMessage" &&
            item.text.includes("已收到后台结果"),
        ),
    );
  }, "自动续跑轮次完成");
  if (liveBrowser) await ui.inspectCompletion();
  const files = await readdir(state);
  const batches = await Promise.all(
    files
      .filter((file) => file.startsWith("batch-") && file.endsWith(".json"))
      .map(async (file) =>
        JSON.parse(await readFile(join(state, file), "utf8")),
      ),
  );
  const batch = batches.find((value) => value.threadId === thread.id);
  assert(
    await received(direct.rpc, batch),
    "真实 Codex 历史必须支持完成结果回执核对",
  );
  await delay(1200);
  assert.equal(jobRequests, 3, "启动工具、结束本轮与自动续跑共三次模型请求");
  assert.equal(nativeRequests.get("enabled"), 3);
  assert.equal(nativeRequests.get("disabled"), 2);
  assert.equal(nativeRequests.get("cancelled"), 2);
  const output = join(root, ".cache/background-codex");
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "evidence.json"),
    JSON.stringify(
      {
        version,
        inference: "本机 Responses 模拟服务，未调用远程模型",
        jobRequests,
        nativeRequests: Object.fromEntries(nativeRequests),
        jobs: delivered.jobs.map(({ status, delivery, exitCode }) => ({
          status,
          delivery,
          exitCode,
        })),
        calls,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS ${version}：MCP 开关、原生 exec_command 订阅交接与停止，${liveBrowser ? "网页实时状态与续跑" : "关闭桥接后自动继续"}，完成结果仅投递一次`,
  );
} finally {
  await ui?.close();
  for (const socket of sockets) socket.terminate();
  for (const child of children.reverse())
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit");
      child.kill();
      await closed;
    }
  inference.closeAllConnections();
  await new Promise((resolve) => inference.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

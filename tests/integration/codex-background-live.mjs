import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { taskRequest } from "../../packages/background-terminal/client.mjs";
import { authenticationFixture } from "../helpers/auth.mjs";
import { backgroundWorkerClock } from "../helpers/background-worker-clock.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source =
  process.env.CODEX_VALIDATION_HOME ||
  process.env.CODEX_HOME ||
  join(homedir(), ".codex");
const binary = process.env.CODEX_BINARY || "codex";
const version = execFileSync(binary, ["--version"], {
  encoding: "utf8",
}).trim();
const model = "gpt-6-luna";
const sleepEnabled = process.env.BACKGROUND_SLEEP_DISABLED !== "1";
const directory = await mkdtemp(join(tmpdir(), "claudex-background-live-"));
const workerClock = await backgroundWorkerClock(directory);
const codexHome = join(directory, "codex");
const webHome = join(directory, "web");
const state = join(directory, "tasks");
const children = [],
  events = [],
  evidence = [];
const payload = randomBytes(4096);
const digest = createHash("sha256").update(payload).digest("hex");
const releaseDownload = Promise.withResolvers();
const http = createServer(async (request, response) => {
  if (request.url !== "/artifact.bin") return response.writeHead(404).end();
  response.writeHead(200, { "Content-Length": payload.length });
  response.write(payload.subarray(0, 16));
  await releaseDownload.promise;
  response.end(payload.subarray(16));
});
let socket,
  diagnostics = "";

function start(command, args, env) {
  const child = spawn(command, args, {
    cwd: directory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-6000);
  });
  return child;
}

async function until(get, description, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await get();
    if (result) return result;
    await delay(80);
  }
  assert.fail(description + "\n" + diagnostics);
}

function completion(threadId, turnId) {
  return until(
    () =>
      events.find(
        ({ method, params }) =>
          method === "turn/completed" &&
          params.threadId === threadId &&
          (turnId ? params.turn.id === turnId : true),
      )?.params.turn,
    "真实模型轮次超时",
  );
}

try {
  await mkdir(codexHome, { mode: 0o700 });
  await copyFile(join(source, "auth.json"), join(codexHome, "auth.json"));
  await writeFile(
    join(codexHome, "config.toml"),
    [
      `model = "${model}"`,
      'model_reasoning_effort = "medium"',
      'cli_auth_credentials_store = "file"',
      "thread_unload_delay_secs = 0",
      "[features]",
      `sleep_tool = ${sleepEnabled ? '{ enabled = true, mode = "always_on" }' : "false"}`,
      "",
    ].join("\n"),
  );
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const port = createServer();
  port.listen(0, "127.0.0.1");
  await once(port, "listening");
  const upstream = `ws://127.0.0.1:${port.address().port}`;
  await new Promise((resolve) => port.close(resolve));
  const env = {
    ...process.env,
    NODE_OPTIONS: workerClock.nodeOptions,
    CODEX_HOME: codexHome,
    CODEX_APP_SERVER_URL: upstream,
    CLAUDEX_BACKGROUND_TASKS_DIR: state,
    CLAUDEX_WEB_CONFIG_DIR: webHome,
    CLAUDEX_WEB_BACKENDS_FILE: join(webHome, "backends.json"),
    CLAUDE_CONFIG_DIR: join(directory, "claude"),
    HOST: "127.0.0.1",
    PORT: "0",
  };
  start(binary, ["app-server", "--listen", upstream], env);
  start(
    process.execPath,
    [
      join(root, "packages/background-terminal/cli.mjs"),
      "serve",
      state,
      upstream,
    ],
    env,
  );
  await until(
    () => taskRequest(state, "health").catch(() => null),
    "任务服务启动超时",
  );
  const auth = await authenticationFixture(webHome);
  await writeFile(
    env.CLAUDEX_WEB_BACKENDS_FILE,
    JSON.stringify({
      version: 1,
      providers: [],
      backends: [
        {
          id: "codex",
          type: "codex",
          enabled: true,
          backgroundTerminalEnabled: true,
        },
        { id: "claude", type: "claude", enabled: false },
      ],
    }),
  );
  const bridge = start(
    process.execPath,
    [join(root, "server/src/server.mjs")],
    env,
  );
  let stdout = "";
  bridge.stdout.on("data", (chunk) => (stdout += chunk));
  const url = await until(
    () => stdout.match(/https:\/\/127\.0\.0\.1:\d+/)?.[0],
    "网页桥接启动超时",
  );
  socket = new WebSocket(url.replace("https:", "wss:") + "/rpc", {
    ca: auth.tls.cert,
    headers: { Cookie: auth.cookie, Origin: url },
  });
  const pending = new Map();
  let sequence = 0;
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes);
    if (message.method) return events.push(message);
    const reply = pending.get(message.id);
    if (message.error) reply?.reject(new Error(message.error.message));
    else reply?.resolve(message.result);
  });
  await once(socket, "open");
  await until(
    () => events.some((e) => e.method === "lan/state" && e.params.ready),
    "原生连接超时",
  );
  async function rpc(method, params = {}) {
    const id = ++sequence;
    const reply = Promise.withResolvers();
    const timeout = setTimeout(
      () => reply.reject(new Error(`${method} 超时`)),
      30000,
    );
    pending.set(id, reply);
    socket.send(JSON.stringify({ id, method, params }));
    try {
      return await reply.promise;
    } finally {
      clearTimeout(timeout);
      pending.delete(id);
    }
  }
  assert.ok((await rpc("model/list")).data.some((m) => m.model === model));
  async function run(name, prompt, release) {
    const cwd = join(directory, name);
    await mkdir(cwd);
    const started = await rpc("thread/start", {
      cwd,
      model,
      allowProviderModelFallback: false,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    assert.equal(started.model, model);
    const threadId = started.thread.id;
    await rpc("thread/name/set", { threadId, name });
    const startTime = Date.now();
    const { turn } = await rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
    });
    const first = await completion(threadId, turn.id);
    const firstTurnMs = Date.now() - startTime;
    assert.equal(first.status, "completed", first.error?.message);
    assert.ok(
      !events.some(
        (e) => e.method === "model/rerouted" && e.params.threadId === threadId,
      ),
    );
    const turns = async () =>
      (await rpc("thread/turns/list", { threadId, itemsView: "full" })).data;
    const firstItems = (await turns()).find(
      (entry) => entry.id === turn.id,
    ).items;
    const calls = firstItems.filter((item) =>
      /Call$|^commandExecution$/.test(item.type),
    );
    const tools = calls.map((item) => item.tool || item.type);
    const list = async () =>
      (
        await taskRequest(state, "tool", {
          threadId,
          name: "background_list",
          args: {},
        })
      ).jobs;
    const checks = {};
    if (release) {
      assert.deepEqual(tools, ["background_start"], name + " 首轮工具");
      assert.equal(calls[0].server, "claudex_background");
      const [job] = await list();
      assert.equal(job?.status, "running");
      assert.equal(job.native, undefined);
      checks.firstDelayMs = job.nextCheckAt - job.startedAt;
      const minutes = name === "download" ? [7, 20] : [3, 8];
      assert.ok(
        checks.firstDelayMs >= minutes[0] * 60_000 &&
          checks.firstDelayMs <= minutes[1] * 60_000,
        name + " 应按任务预估安排检查，实际毫秒 " + checks.firstDelayMs,
      );
      assert.ok(
        firstItems.some(
          (item) => item.type === "agentMessage" && item.text.trim(),
        ),
      );
      await assert.rejects(readFile(join(cwd, "verified.txt")), {
        code: "ENOENT",
      });
      if (name === "build") {
        await writeFile(join(cwd, "progress-ready"), "");
        await until(async () => {
          const result = await taskRequest(state, "tool", {
            threadId,
            name: "background_read",
            args: { job_id: job.id },
          });
          return result.output.includes(
            "remaining phase is expected to need about six minutes",
          );
        }, "等候隔离构建的阶段进度");
        await workerClock.advance(checks.firstDelayMs);
        const check = await until(
          async () =>
            (await turns()).find(
              (entry) =>
                entry.status !== "inProgress" &&
                entry.items?.some(
                  (item) => item.name === "background_check_due",
                ),
            ),
          "真实模型到期检查超时",
        );
        assert.equal(check.status, "completed", check.error?.message);
        checks.checkTools = check.items
          .filter((item) => item.tool)
          .map((item) => item.tool);
        assert.ok(
          checks.checkTools.includes("background_schedule_check"),
          "确认仍在运行时应改期",
        );
        assert.ok(!checks.checkTools.includes("background_cancel"));
        const [scheduled] = await list();
        assert.equal(scheduled.status, "running");
        checks.rescheduledDelayMs =
          scheduled.nextCheckAt - Date.now() - checks.firstDelayMs;
        assert.ok(
          checks.rescheduledDelayMs >= 3 * 60_000,
          "改期应按剩余阶段留足时间",
        );
      }
      await release(cwd);
      const wake = await until(async () => {
        const resumed = (await turns()).find(
          (entry) =>
            entry.id !== first.id &&
            entry.items?.some((item) => item.name === "background_completed"),
        );
        return resumed?.status === "inProgress" ? null : resumed;
      }, "自动续跑超时");
      assert.equal(wake.status, "completed");
      const notice = wake.items.find(
        (item) => item.name === "background_completed",
      );
      const [result] = JSON.parse(notice.output).results;
      assert.equal(result.job_id, job.id);
      assert.equal(result.exit_code, 0);
      assert.equal(
        (await readFile(join(cwd, "verified.txt"), "utf8")).trim(),
        digest,
      );
      assert.ok(
        wake.items.some(
          (item) => item.type === "agentMessage" && item.text.trim(),
        ),
      );
    } else {
      assert.equal(tools[0], "commandExecution");
      assert.deepEqual(await list(), []);
      assert.equal(
        (await readFile(join(cwd, "quick.txt"), "utf8")).trim(),
        "quick-ok",
      );
    }
    evidence.push({
      name,
      tools,
      firstTurnMs,
      continued: Boolean(release),
      ...checks,
    });
    console.log(JSON.stringify(evidence.at(-1)));
  }
  const build =
    'node -e \'const fs=require("node:fs"); let reported=false; const timer=setInterval(()=>{if(!reported&&fs.existsSync("progress-ready")){reported=true;console.log("Setup complete. Test fixture is supplying the next input and the remaining phase is expected to need about six minutes.")}if(fs.existsSync("release.bin")){clearInterval(timer);fs.copyFileSync("release.bin","artifact.bin")}},100)\'';
  const download = `curl --noproxy '*' -fsS http://127.0.0.1:${http.address().port}/artifact.bin -o artifact.bin`;
  const verify =
    "成功后计算 artifact.bin 的 SHA-256，把十六进制哈希写到 verified.txt，并报告结果。";
  const runs = await Promise.allSettled([
    run(
      "download",
      `下载任务预计 10 分钟。请执行 \`${download}\`。${verify}`,
      () => releaseDownload.resolve(),
    ),
    run(
      "build",
      `这是一个预计 4 分钟的隔离构建，请运行命令 \`${build}\`，测试服务会提供输入。${verify}`,
      (cwd) => writeFile(join(cwd, "release.bin"), payload),
    ),
    run("quick", "请执行 `printf 'quick-ok\\n' > quick.txt`，完成后报告结果。"),
  ]);
  for (const result of runs)
    if (result.status === "rejected") throw result.reason;
  console.log(JSON.stringify({ version, model, sleepEnabled, evidence }));
} finally {
  releaseDownload.resolve();
  socket?.terminate();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

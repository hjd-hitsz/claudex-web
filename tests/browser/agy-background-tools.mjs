import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createWebApplication } from "../../server/src/application.mjs";
import { createAuthentication } from "../../server/src/auth.mjs";
import { readConfig } from "../../server/src/config.mjs";
import { createBackendConfiguration } from "../../server/src/backends/configuration.mjs";
import {
  connectIpc,
  workerLocation,
} from "../../server/src/backends/agy/worker-ipc.mjs";
import { taskRequest } from "../../packages/background-terminal/client.mjs";
import { authenticationFixture } from "../helpers/auth.mjs";

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const agy =
  process.env.AGY_EXECUTABLE ||
  execFileSync("which", ["agy"], { encoding: "utf8" }).trim();
const codex =
  process.env.CODEX_EXECUTABLE ||
  execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
const version = Object.fromEntries(
  [
    ["agy", agy],
    ["codex", codex],
  ].map(([name, path]) => [
    name,
    execFileSync(path, ["--version"], { encoding: "utf8" }).trim(),
  ]),
);
const root = await mkdtemp(join(tmpdir(), "agy-tools-"));
const output = resolve(
  process.env.AGY_TOOLS_OUTPUT || ".cache/agy-background-tools/browser",
);
const cwd = join(root, "workspace");
const bin = join(root, "bin");
const home = join(root, "home");
const profile = join(home, ".gemini", "antigravity-cli");
const codexHome = join(root, "codex");
await Promise.all(
  [cwd, bin, profile, codexHome, output].map((path) =>
    mkdir(path, { recursive: true }),
  ),
);
await writeFile(
  join(profile, "settings.json"),
  JSON.stringify({
    modelProvider: "gemini",
    auth: { type: "gemini-api-key" },
  }),
);
const escape = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const acpLog = join(root, "agy-acp.ndjson");
await writeFile(
  join(bin, "agy"),
  `#!/bin/sh
if [ "$1" = acp ]; then
  tee -a ${escape(acpLog)} | ${escape(agy)} "$@" --disable-telemetry
else
  exec ${escape(agy)} "$@"
fi
`,
  { mode: 0o700 },
);
await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
Object.assign(process.env, {
  HOME: home,
  PATH: bin + ":" + process.env.PATH,
  XDG_RUNTIME_DIR: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  GEMINI_API_KEY: "agy-tools-fixture",
});
for (const key of Object.keys(process.env))
  if (
    /^(https?|all|no)_proxy$/i.test(key) ||
    key === "DBUS_SESSION_BUS_ADDRESS"
  )
    delete process.env[key];

const evidence = {
  version,
  gemini: [],
  responses: [],
  nativeAcp: {},
  rpc: {},
  zoom: [],
};
const gemini = createServer(async (req, res) => {
  if (req.method === "GET") return res.end('{"models":[]}');
  const body = await readJson(req);
  const text = JSON.stringify(body.contents);
  const tools =
    body.tools?.flatMap((item) => item.functionDeclarations || []) || [];
  const target = tools.find(
    ({ name }) => name === "mcp_claudex_delegation_ask_codex",
  );
  const trace = ["外部终端验证", "主会话终端验证"].find((name) =>
    text.includes(name),
  );
  const called = body.contents?.some(({ parts }) =>
    parts?.some(
      ({ functionResponse }) => functionResponse?.name === target?.name,
    ),
  );
  const title = JSON.stringify(body.systemInstruction).includes(
    "conversation title generator",
  );
  const part =
    !title && trace && target && !called
      ? {
          functionCall: {
            name: target.name,
            args: {
              request: trace,
              request_id: trace === "外部终端验证" ? "foreign" : "primary",
              scope: "implementation",
              toolSummary: trace,
            },
          },
        }
      : { text: title ? "终端验收" : "已收到验收请求。" };
  evidence.gemini.push({
    title,
    trace,
    hasDelegationTool: Boolean(target),
    called: Boolean(part.functionCall),
    toolResult: body.contents
      ?.at(-1)
      ?.parts?.find(({ functionResponse }) => functionResponse)
      ?.functionResponse?.response,
  });
  const response = JSON.stringify({
    candidates: [
      { content: { role: "model", parts: [part] }, finishReason: "STOP" },
    ],
    usageMetadata: {
      promptTokenCount: 32,
      candidatesTokenCount: 8,
      totalTokenCount: 40,
    },
  });
  if (req.url.includes("streamGenerateContent"))
    return res
      .writeHead(200, { "content-type": "text/event-stream" })
      .end("data: " + response + "\n\n");
  res.writeHead(200, { "content-type": "application/json" }).end(response);
});
const starts = new Map();
const responses = createServer(async (req, res) => {
  if (req.url !== "/v1/responses") return res.writeHead(404).end();
  const body = await readJson(req);
  const title = body.text?.format?.type === "json_schema";
  const text = JSON.stringify(body.input);
  const primary = text.includes("主会话终端验证");
  const group = primary ? "primary" : "foreign";
  const sequence = (starts.get(group) || 0) + 1;
  const id = "fixture-" + (evidence.responses.length + 1);
  let item = {
    id: "message-" + id,
    type: "message",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: title ? '{"title":"后台终端验收"}' : "已提交验收命令。",
      },
    ],
  };
  if (!title && sequence <= (primary ? 2 : 1)) {
    const tool = body.tools
      .flatMap(
        (entry) =>
          entry.tools?.map((child) => ({
            ...child,
            namespace: entry.name,
          })) || [entry],
      )
      .find(({ name }) => name === "background_start");
    assert(tool);
    starts.set(group, sequence);
    const marker = group.toUpperCase() + "_" + sequence;
    item = {
      type: "function_call",
      name: tool.name,
      namespace: tool.namespace,
      call_id: "start-" + marker,
      arguments: JSON.stringify({
        title: marker,
        command: `printf '%s\\n' '${marker}_OUTPUT'; exec sleep 600`,
        check_after_ms: 300000,
      }),
    };
  }
  evidence.responses.push({
    title,
    group,
    tool: item.name,
    index: evidence.responses.length + 1,
  });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    [
      { type: "response.created", response: { id } },
      { type: "response.output_item.done", item },
      {
        type: "response.completed",
        response: {
          id,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
        },
      },
    ]
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
  );
});
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks));
}
const reserve = createServer();
for (const server of [gemini, responses, reserve]) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}
const upstream = "ws://127.0.0.1:" + reserve.address().port;
await new Promise((done) => reserve.close(done));
process.env.GOOGLE_GEMINI_BASE_URL =
  "http://127.0.0.1:" + gemini.address().port;
await writeFile(
  join(codexHome, "config.toml"),
  `
model = "gpt-5.4"
model_provider = "fixture"
[model_providers.fixture]
name = "fixture"
base_url = "http://127.0.0.1:${responses.address().port}/v1"
wire_api = "responses"
`,
);
const config = readConfig({
  ...process.env,
  CLAUDEX_WEB_CONFIG_DIR: root,
  CLAUDEX_BACKGROUND_TASKS_DIR: join(root, "jobs"),
  CODEX_HOME: codexHome,
  CLAUDE_CONFIG_DIR: join(root, "claude"),
  CODEX_APP_SERVER_URL: upstream,
  DEFAULT_CWD: cwd,
  HOST: "127.0.0.1",
  PORT: "0",
});
const store = createBackendConfiguration(config);
await store.save({
  id: "codex",
  type: "codex",
  enabled: true,
  backgroundTerminalEnabled: true,
});
await store.save({ id: "claude", type: "claude", enabled: false });
const backend = await store.save({
  id: "agy",
  type: "agy",
  enabled: true,
  proxy: { mode: "off" },
  delegates: { codex: { enabled: true, model: "gpt-5.4", effort: "low" } },
});
const native = spawn(codex, ["app-server", "--listen", upstream], {
  cwd,
  env: { ...process.env, CODEX_HOME: codexHome },
  stdio: ["ignore", "ignore", "pipe"],
});
const service = spawn(
  process.execPath,
  [
    fileURLToPath(
      new URL("../../packages/background-terminal/cli.mjs", import.meta.url),
    ),
    "serve",
    config.backgroundTaskDir,
    upstream,
  ],
  { cwd, stdio: ["ignore", "ignore", "pipe"] },
);
let nativeErrors = "";
for (const child of [native, service])
  child.stderr.on("data", (chunk) => {
    nativeErrors = (nativeErrors + chunk).slice(-5000);
  });
const auth = await authenticationFixture(root);
const app = createWebApplication({
  config,
  tls: auth.tls,
  authentication: await createAuthentication(config),
  version: { version: "4.2.3", displayVersion: "4.2.3" },
});
async function until(read, label) {
  for (const start = Date.now(); Date.now() - start < 25000;) {
    const result = await read();
    if (result) return result;
    await delay(100);
  }
  throw new Error(label);
}
const jobs = async (threadId) =>
  (
    await taskRequest(config.backgroundTaskDir, "tool", {
      name: "background_list",
      args: {},
      threadId,
      expectedUpstream: new URL(upstream).href,
    })
  ).jobs;
const state = async () =>
  JSON.parse(await readFile(join(backend.stateDir, "state.json"), "utf8"));

let browser;
let page;
try {
  await until(
    () =>
      fetch(upstream.replace("ws:", "http:") + "/readyz").then(
        (response) => response.ok,
        () => false,
      ),
    "Codex app-server 未就绪",
  );
  await until(
    () => taskRequest(config.backgroundTaskDir, "health").catch(() => null),
    "后台任务服务未就绪",
  );
  await app.start();
  const url = "https://127.0.0.1:" + app.server.address().port;
  browser = await chromium.launchPersistentContext(join(root, "browser"), {
    executablePath: process.env.CHROME_PATH,
    args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
    ignoreHTTPSErrors: true,
    viewport: { width: 1400, height: 920 },
    colorScheme: "light",
  });
  await browser.addCookies([
    {
      name: "__Host-claudex-web-session",
      value: auth.cookie.split("=")[1],
      url,
      httpOnly: true,
    },
  ]);
  await browser.addInitScript(() => {
    if (!localStorage.getItem("cx-backend"))
      localStorage.setItem("cx-backend", JSON.stringify("agy"));
  });
  page = await browser.newPage();
  page.setDefaultTimeout(20000);
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const { method, params } = JSON.parse(payload);
      const key =
        (params?.threadId?.startsWith("backend:agy:") ? "agy " : "") + method;
      evidence.rpc[key] = (evidence.rpc[key] || 0) + 1;
    }),
  );
  await page.goto(url);
  await page.getByRole("heading", { name: /今天想完成什么/ }).waitFor();
  const button = (name) =>
    page.getByRole("button", { name, exact: typeof name === "string" });
  const message = page.getByRole("textbox", { name: "消息", exact: true });
  const capture = (name) =>
    page.screenshot({
      path: join(output, name + ".png"),
      animations: "disabled",
    });
  const tasks = page.getByRole("region", {
    name: "后台终端",
    exact: true,
    includeHidden: true,
  });
  const counter = button(/后台终端，\d+ 个运行中/);
  async function send(text) {
    await message.fill(text);
    await button("发送消息").click();
  }
  async function openOverview() {
    const open = button("展开对话详情");
    if (await open.isVisible()) await open.click();
  }
  async function assertEmpty() {
    assert.equal(await counter.count(), 0);
    assert.equal(await tasks.count(), 0);
    assert.equal(await page.locator(".inline-error:visible").count(), 0);
  }
  function openPlugins() {
    return button("插件与连接").click();
  }
  await send("现在直接回复验收请求。");
  await page.getByText("已收到验收请求。", { exact: true }).waitFor();
  await openOverview();
  await assertEmpty();
  await capture("01-empty-light");
  await openPlugins();
  const plugins = page.getByRole("dialog", { name: "插件与连接" });
  await plugins.getByText("当前工作目录没有已安装插件。").waitFor();
  await plugins.getByText("claudex_delegation", { exact: true }).waitFor();
  await plugins.getByText(/\d+ 项工具 · 已连接/).waitFor();
  assert.equal(await plugins.getByRole("alert").count(), 0);
  await capture("02-plugins-empty-light");
  await page.keyboard.press("Escape");
  execFileSync(agy, ["mcp", "add", "fixture_configured", "--", "/bin/true"], {
    cwd,
  });
  execFileSync(agy, ["mcp", "add", "fixture_disabled", "--", "/bin/true"], {
    cwd,
  });
  execFileSync(agy, ["mcp", "disable", "fixture_disabled"], { cwd });
  await openPlugins();
  await plugins.getByText("fixture_configured", { exact: true }).waitFor();
  await plugins.getByText("已配置", { exact: true }).waitFor();
  await plugins.getByText("fixture_disabled", { exact: true }).waitFor();
  await plugins.getByText("已停用", { exact: true }).waitFor();
  await plugins.getByText(/\d+ 项工具 · 已连接/).waitFor();
  await capture("03-plugins-configured-light");
  await page.keyboard.press("Escape");
  await send("外部终端验证");
  const foreign = await until(
    async () =>
      Object.values((await state()).tasks).find(
        (task) =>
          task.steps[0]?.request === "外部终端验证" && task.executor?.threadId,
      ),
    "外部委派未受理",
  );
  await button("停止 FOREIGN_1").waitFor();
  await page
    .locator(".primary-nav")
    .getByRole("button", { name: "新对话" })
    .click();
  await send("主会话终端验证");
  await counter.waitFor();
  await openOverview();
  await button("停止 PRIMARY_2").waitFor();
  assert.equal(await button("停止 FOREIGN_1").count(), 0);
  const main = await until(
    async () =>
      Object.values((await state()).tasks).find(
        (task) =>
          task.steps[0]?.request === "主会话终端验证" &&
          task.executor?.threadId,
      ),
    "主会话委派未受理",
  );
  await capture("04-list-light");
  await tasks.getByRole("button", { name: /^PRIMARY_1\b/ }).click();
  const log = page.getByRole("region", { name: "后台终端输出" });
  await log.getByText("PRIMARY_1_OUTPUT", { exact: true }).waitFor();
  await page.emulateMedia({ colorScheme: "dark" });
  await capture("05-output-dark");
  await button("返回概览").click();
  await button("停止 PRIMARY_1").click();
  await button("停止 PRIMARY_1").waitFor({ state: "detached" });
  await until(
    async () =>
      (await jobs(main.executor.threadId)).some(
        (job) =>
          job.title === "PRIMARY_1" &&
          job.status === "cancelled" &&
          job.completedAt,
      ),
    "单项停止未结束进程",
  );
  assert(
    (await jobs(main.executor.threadId)).some(
      (job) => job.title === "PRIMARY_2" && job.status === "running",
    ),
  );
  const settings = await browser.newPage();
  await settings.goto("chrome://settings/appearance");
  const zoom = settings.locator("#zoomLevel");
  for (const width of [1400, 390]) {
    await page.setViewportSize({ width, height: 920 });
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
        await zoom.selectOption(String(scale));
        await page.waitForFunction(
          (scale) => Math.abs(devicePixelRatio - scale) < 0.02,
          scale,
        );
        const geometry = await page.evaluate(() => ({
          viewport: innerWidth,
          scroll: document.documentElement.scrollWidth,
          dpr: devicePixelRatio,
        }));
        assert(
          Math.abs(geometry.viewport - width / scale) <= 1 &&
            geometry.scroll <= geometry.viewport + 1,
          JSON.stringify(geometry),
        );
        evidence.zoom.push({ width, colorScheme, scale, ...geometry });
      }
      await zoom.selectOption("1");
      await openOverview();
      await button("停止 PRIMARY_2").waitFor();
      await capture(`06-list-${width}-${colorScheme}`);
    }
  }
  await settings.close();
  await button("折叠对话详情").click();
  await button("显示侧栏").click();
  await button("插件与连接").waitFor();
  await openPlugins();
  await plugins.getByText("claudex_delegation", { exact: true }).waitFor();
  await capture("07-plugins-mobile-dark");
  await page.keyboard.press("Escape");
  await button("收起侧栏").click();
  await button("显示侧栏").waitFor();
  assert(
    await page.evaluate(() => !document.activeElement?.closest(".sidebar")),
  );
  await send("/stop");
  const stop = page.getByRole("dialog", { name: "清理后台终端" });
  await stop.getByText(/PRIMARY_2_OUTPUT/).waitFor();
  assert.equal(await stop.getByText(/FOREIGN_1_OUTPUT/).count(), 0);
  await capture("08-stop-mobile-dark");
  await stop.getByRole("button", { name: "停止全部后台终端" }).click();
  await stop.getByText("当前对话没有后台终端。").waitFor();
  await until(
    async () =>
      (await jobs(main.executor.threadId)).every(
        (job) => job.status === "cancelled" && job.completedAt,
      ),
    "批量停止未结束进程",
  );
  assert(
    (await jobs(foreign.executor.threadId)).some(
      (job) => job.title === "FOREIGN_1" && job.status === "running",
    ),
  );
  const unrelated = (await jobs(foreign.executor.threadId)).find(
    (job) => job.title === "FOREIGN_1",
  );
  evidence.stops = {
    current: (await jobs(main.executor.threadId)).map(
      ({ title, status, completedAt }) => ({
        title,
        status,
        exited: Boolean(completedAt),
      }),
    ),
    other: unrelated.status,
  };
  await taskRequest(config.backgroundTaskDir, "tool", {
    name: "background_cancel",
    args: { job_id: unrelated.id },
    threadId: foreign.executor.threadId,
  });
  await page.keyboard.press("Escape");
  await counter.waitFor({ state: "detached" });
  await openOverview();
  await assertEmpty();
  await capture("09-empty-mobile-dark");
  const methods = (await readFile(acpLog, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).method)
    .filter(Boolean);
  for (const method of methods)
    evidence.nativeAcp[method] = (evidence.nativeAcp[method] || 0) + 1;
  assert(methods.includes("session/prompt"));
  assert(
    !methods.some((method) =>
      /tasks|terminal|cancel|plugin|mcpServerStatus/i.test(method),
    ),
  );
  evidence.passed = true;
  console.log(
    JSON.stringify({
      passed: true,
      version,
      zoom: evidence.zoom.length,
      output,
    }),
  );
} catch (error) {
  console.error(nativeErrors);
  evidence.tasks = Object.values(
    (await state().catch(() => ({ tasks: {} }))).tasks,
  ).map(({ status, steps }) => ({
    status,
    steps: steps.map(({ request, result }) => ({
      request,
      error: result?.error,
    })),
  }));
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await writeFile(
    join(output, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  await browser?.close();
  await app.close();
  const worker = await connectIpc(
    workerLocation(backend.stateDir).socket,
  ).catch(() => null);
  if (worker) {
    const {
      params: { pid },
    } = await worker.call("state");
    await worker.call("shutdown").catch(() => process.kill(pid, "SIGTERM"));
    worker.close();
  }
  for (const child of [service, native]) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
  }
  gemini.close();
  responses.close();
  await rm(root, { recursive: true, force: true });
}

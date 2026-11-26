import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import WebSocket from "ws";
import { createWebApplication } from "../../server/src/application.mjs";
import { createAuthentication } from "../../server/src/auth.mjs";
import { createBackendConfiguration } from "../../server/src/backends/configuration.mjs";
import {
  connectIpc,
  workerLocation,
} from "../../server/src/backends/agy/worker-ipc.mjs";
import { readConfig } from "../../server/src/config.mjs";
import { networkProxyEnvironment } from "../../server/src/backends/network-proxy.mjs";
import { authenticationFixture } from "../helpers/auth.mjs";
import { switchComposerBackend } from "../helpers/settings-navigation.mjs";

const exec = promisify(execFile);
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const testHome = join(homedir(), ".cache");
await mkdir(testHome, { recursive: true });
const root = await mkdtemp(join(testHome, "claudex-agy-live-"));
const cwd = join(root, "audit-demo");
const codexHome = join(root, "codex");
const authHome = process.env.AGY_LIVE_CODEX_HOME || join(homedir(), ".codex");
const artifacts = process.env.AGY_LIVE_OUTPUT_DIR || ".cache/agy-live-browser";
await Promise.all(
  [cwd, codexHome, artifacts].map((path) => mkdir(path, { recursive: true })),
);
await symlink(join(authHome, "auth.json"), join(codexHome, "auth.json"));
const proof = "CX-" + randomBytes(5).toString("hex").toUpperCase();
await writeFile(
  join(cwd, "release.toml"),
  'version = "2.3.1"\nchannel = "stable"\n',
);
await writeFile(
  join(cwd, "QA.md"),
  "# 发布验收\n预期版本为 2.3.1，渠道为 stable。\n本次验证记录编号为 " +
    proof +
    "。\n",
);
const outputFile = join(cwd, "verification.md");
const proxyAddress = process.env.AGY_LIVE_PROXY || process.env.HTTPS_PROXY;
const proxyUrl = proxyAddress && new URL(proxyAddress);
assert(
  !proxyUrl ||
    (proxyUrl.protocol === "http:" && !proxyUrl.username && !proxyUrl.password),
  "需要 CLI 可用的代理环境",
);
const proxy = proxyUrl && {
  mode: "http",
  host: proxyUrl.hostname,
  port: Number(proxyUrl.port || 80),
};
const reserve = createServer();
reserve.listen(0, "127.0.0.1");
await once(reserve, "listening");
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const upstream = "ws://127.0.0.1:" + port;
const config = readConfig({
  ...process.env,
  CODEX_HOME: codexHome,
  CLAUDE_CONFIG_DIR: join(root, "claude"),
  CLAUDEX_WEB_CONFIG_DIR: root,
  CLAUDEX_WEB_BACKENDS_FILE: join(root, "backends.json"),
  DEFAULT_CWD: cwd,
  HOST: "127.0.0.1",
  PORT: "0",
  CODEX_APP_SERVER_URL: upstream,
});
const location = workerLocation(join(root, "backends/agy"));
const native = spawn("codex", ["app-server", "--listen", upstream], {
  cwd,
  env: {
    ...process.env,
    ...networkProxyEnvironment(proxy || undefined),
    CODEX_HOME: codexHome,
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let nativeError = "";
native.stderr.on(
  "data",
  (chunk) => (nativeError = (nativeError + chunk).slice(-2400)),
);
const workState = async () => {
  try {
    return JSON.parse(
      await readFile(join(root, "backends/agy/state.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
};
async function until(read, message, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(140);
  }
  throw new Error(message);
}
async function readCodexModels() {
  const socket = await until(
    () =>
      new Promise((resolve) => {
        if (native.exitCode !== null)
          throw new Error("Codex app-server 已退出");
        const peer = new WebSocket(upstream);
        peer.once("open", () => resolve(peer));
        peer.once("error", () => resolve(null));
      }),
    "Codex app-server 启动超时",
    15000,
  );
  const call = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(method + " 超时")),
        10000,
      );
      const onMessage = (raw) => {
        const packet = JSON.parse(raw);
        if (packet.id !== id) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        if (packet.error) reject(new Error(packet.error.message));
        else resolve(packet.result);
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({ id, method, params }));
    });
  try {
    await call(1, "initialize", {
      clientInfo: { name: "claudex-live-audit", version: "1" },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized" }));
    return (await call(2, "model/list", { limit: 100, includeHidden: false }))
      .data;
  } finally {
    socket.close();
  }
}
let app, browser, page, codexModel;
const frames = [];
async function startBridge(auth, port) {
  app = createWebApplication({
    config: { ...config, port },
    tls: auth.tls,
    authentication: await createAuthentication(config),
    version: { version: "4.2.2", displayVersion: "4.2.2" },
  });
  await app.start();
}

async function openCodexDelegation() {
  const toggle = page.getByRole("button", {
    name: "展开对话详情",
    exact: true,
  });
  if (await toggle.isVisible()) await toggle.click();
  await page
    .locator(".context-agent-list")
    .getByRole("button", { name: /Codex/ })
    .click();
  const detail = page.getByRole("region", { name: "Codex 委派对话" });
  await detail.waitFor();
  return detail;
}

try {
  const models = await readCodexModels();
  codexModel =
    process.env.AGY_LIVE_CODEX_MODEL ||
    (models.find((model) => model.isDefault) || models[0])?.model;
  assert(codexModel, "Codex 未返回可用模型");
  const settings = createBackendConfiguration(config);
  await settings.save({ id: "codex", type: "codex", enabled: true });
  await settings.save({
    id: "agy",
    type: "agy",
    enabled: true,
    ...(proxy && { proxy }),
    delegates: { codex: { enabled: true, model: codexModel, effort: "low" } },
  });
  const auth = await authenticationFixture(root);
  await startBridge(auth, 0);
  const bridgePort = app.server.address().port;
  const url = "https://127.0.0.1:" + bridgePort;
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies([
    {
      name: "__Host-claudex-web-session",
      value: auth.cookie.split("=")[1],
      url,
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  page = await context.newPage();
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      frames.push(JSON.parse(payload));
    }),
  );
  await page.goto(url);
  await page.waitForFunction(() =>
    document
      .querySelector(".backend-switcher button")
      ?.getAttribute("aria-label"),
  );
  await page.getByRole("button", { name: /切换后端，当前为 / }).click();
  await page
    .getByRole("group", { name: "切换后端", exact: true })
    .getByRole("button", { name: "Antigravity", exact: true })
    .waitFor();
  const option = page
    .getByRole("group", { name: "切换后端", exact: true })
    .getByRole("button", { name: "Antigravity", exact: true });
  await until(() => option.isEnabled(), "Antigravity 连接超时", 30000);
  await page.keyboard.press("Escape");
  await switchComposerBackend(page, "Antigravity");
  console.log("真实网页已连接 Antigravity，等待原生目录");
  const model = page.getByRole("combobox", { name: "模型", exact: true });
  const nativeOptions = await until(
    async () => {
      const labels = await model.locator("option").allTextContents();
      return labels.length > 1 && labels;
    },
    "首轮之前未取得 Antigravity 原生目录",
    30000,
  );
  console.log("网页已读取原生模型目录", nativeOptions.length);
  const project = page.getByRole("button", { name: /切换项目文件夹/ });
  if (!(await project.getAttribute("aria-label")).includes("audit-demo")) {
    throw new Error("验收工作目录未选中");
  }
  const prompt =
    "请通过 ask_codex 委派 Codex 只读核对当前目录的 release.toml 和 QA.md，交回实际版本、渠道、两处文件行号及 QA.md 中真实的验证记录编号。受理后先结束本轮，收到后台结果后请亲自核对并写入 verification.md，最后回复结论和记录编号。";
  await page.getByRole("textbox", { name: "消息", exact: true }).fill(prompt);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  console.log("已通过真实网页提交验收任务，Codex 模型", codexModel);
  const task = await until(
    async () => Object.values((await workState()).tasks || {})[0],
    "真实 Antigravity 未调用 ask_codex",
  );
  assert.equal(task.target, "codex");
  const detail = await openCodexDelegation();
  await page.screenshot({
    path: join(artifacts, "01-delegated.png"),
    animations: "disabled",
  });
  console.log("真实 MCP 委派已受理，执行端为 Codex");
  const finished = await until(
    async () => {
      const current = await workState();
      const execution = current.tasks?.[task.id];
      if (
        execution &&
        ["failed", "interrupted", "unknown"].includes(execution.status)
      )
        throw new Error(
          execution.steps.at(-1).result?.error || "Codex 原生轮次未完成",
        );
      const result = execution?.steps.find(({ result }) =>
        result?.answer?.includes(proof),
      );
      const notice = Object.values(current.notices || {}).find(
        (entry) =>
          entry.taskId === task.id &&
          entry.status === "delivered" &&
          entry.payload?.answer?.includes(proof),
      );
      if (!result || !notice) return;
      const doc = await readFile(outputFile, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      const parent = current.sessions[task.parentId];
      const reply = parent.turns.findLast(
        ({ status, items }) =>
          status === "completed" &&
          items.some(
            ({ type, text }) =>
              type === "agentMessage" && text?.includes(proof),
          ),
      );
      if (doc.includes(proof) && reply)
        return { execution, result, reply, notice };
    },
    "等待 Codex 结果回传与 Antigravity 文档落盘超时",
    150000,
  );
  assert(finished.execution.executor.threadId && finished.result.turnId);
  assert(
    finished.result.result.evidence.some(({ output }) =>
      output?.includes(proof),
    ),
  );
  assert(
    !frames.some(
      ({ method, params }) =>
        method === "lan/agy/permission" && !params.executorName,
    ),
  );
  await page
    .locator(".message-column .assistant-message")
    .filter({ hasText: proof })
    .waitFor();
  await detail.getByText(proof, { exact: false }).first().waitFor();
  assert.equal(
    await detail.getByRole("button", { name: "查看执行会话" }).count(),
    0,
  );
  assert.equal(await page.getByText(/agy 不支持此操作/).count(), 0);
  const visibleThreads = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(
          location.origin.replace("https:", "wss:") + "/rpc",
        );
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("读取目录超时"));
        }, 8000);
        socket.onopen = () =>
          socket.send(
            JSON.stringify({
              id: "proof-list",
              method: "thread/list",
              params: { backendId: "codex", limit: 20 },
            }),
          );
        socket.onmessage = ({ data }) => {
          const message = JSON.parse(data);
          if (message.id !== "proof-list") return;
          clearTimeout(timer);
          socket.close();
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result.data.map(({ id }) => id));
        };
      }),
  );
  assert(!visibleThreads.includes(finished.execution.executor.threadId));
  await page.screenshot({
    path: join(artifacts, "02-result-returned.png"),
    animations: "disabled",
  });
  await detail.locator(".process-group summary").last().click();
  await page.screenshot({
    path: join(artifacts, "03-native-codex.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "返回概览" }).click();
  const reopened = await openCodexDelegation();
  await reopened.getByText(proof, { exact: false }).first().waitFor();

  await app.close();
  app = undefined;
  const worker = await connectIpc(location.socket);
  const beforeRestart = (await worker.call("state")).params.pid;
  const stopped = once(worker.socket, "close");
  await until(
    async () => {
      try {
        await worker.call("shutdown");
        return true;
      } catch (error) {
        if (error.message === "agy 仍有执行中的会话或委派任务") return false;
        throw error;
      }
    },
    "等待在途请求结束并停止隔离 Antigravity 服务",
    30000,
  );
  await stopped;
  await until(() => {
    try {
      process.kill(beforeRestart, 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
  }, "等待旧 Antigravity 工作进程退出");
  await startBridge(auth, bridgePort);
  const restartedWorker = await connectIpc(location.socket);
  try {
    assert.notEqual(
      (await restartedWorker.call("state")).params.pid,
      beforeRestart,
    );
  } finally {
    restartedWorker.close();
  }
  await page.reload();
  await page
    .locator(".message-column .assistant-message")
    .filter({ hasText: proof })
    .waitFor();
  const restored = await openCodexDelegation();
  await restored.getByText("执行已结束", { exact: true }).waitFor();
  await restored.getByText(proof, { exact: false }).first().waitFor();
  assert.equal(await restored.getByRole("alert").count(), 0);
  await page.getByRole("textbox", { name: "消息", exact: true }).waitFor();
  await page.screenshot({
    path: join(artifacts, "04-reopened-after-restart.png"),
    animations: "disabled",
  });
  const sessions = join(codexHome, "sessions");
  const traces = (await readdir(sessions, { recursive: true })).filter((name) =>
    name.endsWith(".jsonl"),
  );
  const policies = new Set();
  for (const trace of traces) {
    const content = await readFile(join(sessions, trace), "utf8");
    for (const line of content.trim().split("\n")) {
      const { type, payload } = JSON.parse(line);
      if (type === "turn_context" && payload?.sandbox_policy?.type)
        policies.add(payload.sandbox_policy.type);
    }
  }
  assert(policies.has("danger-full-access"), "原生轮次未记录完全访问权限");
  const report = {
    codexModel,
    nativeOptions,
    proof,
    accepted: true,
    codexAccess: [...policies],
    antigravityPermissionPrompts: 0,
    hiddenFromProjectList: true,
    reopenedAfterCompletion: true,
    reopenedAfterBridgeAndWorkerRestart: true,
    originalAgyTurn: task.parentTurnId,
    nativeCodexThread: finished.execution.executor.threadId,
    nativeCodexTurn: finished.result.turnId,
    notice: finished.notice.status,
    resultAgyTurn: finished.reply.id,
    document: await readFile(outputFile, "utf8"),
  };
  await writeFile(
    join(artifacts, "verified.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    "真实 Antigravity → Codex → 原会话唤醒 → 文档写入 → 重启后重新打开通过",
    proof,
  );
} catch (error) {
  const data = await workState().catch(() => ({}));
  console.error({
    codexModel,
    tasks: Object.values(data.tasks || {}).map(
      ({ status, target, executor, steps }) => ({
        status,
        target,
        executor: Boolean(executor),
        steps: steps.map(({ turnId, result }) => ({
          turn: Boolean(turnId),
          error: result?.error,
          answer: result?.answer?.slice(0, 300),
        })),
      }),
    ),
    nativeError,
  });
  if (page)
    await page
      .screenshot({
        path: join(artifacts, "failure.png"),
        animations: "disabled",
      })
      .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  const peer = await connectIpc(location.socket).catch(() => null);
  if (peer) {
    await peer.call("shutdown").catch(async () => {
      await exec("systemctl", [
        "--user",
        "stop",
        location.unit + ".service",
      ]).catch(() => {});
    });
    peer.close();
  }
  native.kill();
  await rm(root, { recursive: true, force: true });
}

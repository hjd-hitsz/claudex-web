import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createWebApplication } from "../../server/src/application.mjs";
import { createAuthentication } from "../../server/src/auth.mjs";
import { createAcpClient } from "../../server/src/backends/agy/acp-client.mjs";
import {
  connectIpc,
  workerLocation,
} from "../../server/src/backends/agy/worker-ipc.mjs";
import { createBackendConfiguration } from "../../server/src/backends/configuration.mjs";
import { readConfig } from "../../server/src/config.mjs";
import { authenticationFixture } from "../helpers/auth.mjs";

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const executable =
  process.env.AGY_EXECUTABLE ||
  execFileSync("which", ["agy"], { encoding: "utf8" }).trim();
const version = execFileSync(executable, ["--version"], {
  encoding: "utf8",
}).trim();
assert.equal(version, "1.5.18");
const output = resolve(
  process.env.AGY_METADATA_OUTPUT || ".cache/agy-history-metadata/browser",
);
const root = await mkdtemp(join(tmpdir(), "claudex-agy-history-metadata-"));
const home = join(root, "home");
const cwd = join(root, "workspace");
const bin = join(root, "bin");
const profile = join(home, ".gemini", "antigravity-cli");
await Promise.all(
  [output, cwd, bin, profile].map((path) => mkdir(path, { recursive: true })),
);
await writeFile(
  join(profile, "settings.json"),
  JSON.stringify({
    modelProvider: "gemini",
    auth: { type: "gemini-api-key" },
  }),
);
await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
Object.assign(process.env, {
  HOME: home,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_RUNTIME_DIR: root,
  PATH: bin + ":" + process.env.PATH,
  GEMINI_API_KEY: "isolated-agy-metadata",
});
delete process.env.DBUS_SESSION_BUS_ADDRESS;

const prompts = [];
const model = createServer(async (req, res) => {
  if (req.method === "GET") return res.end('{"models":[]}');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const { contents, systemInstruction } = JSON.parse(Buffer.concat(chunks));
  const title = JSON.stringify(systemInstruction).includes(
    "conversation title generator",
  );
  const input = contents.at(-1).parts.at(-1).text;
  if (!title) prompts.push(input);
  const text = title
    ? input.includes("保留会话")
      ? "保留会话"
      : "验收目标"
    : input.includes("保留会话")
      ? "对照记录完整。"
      : "目标记录已保存。";
  const body = JSON.stringify({
    candidates: [
      { content: { role: "model", parts: [{ text }] }, finishReason: "STOP" },
    ],
    usageMetadata: {
      promptTokenCount: 120,
      candidatesTokenCount: 16,
      totalTokenCount: 136,
    },
  });
  if (req.url.includes("streamGenerateContent"))
    return res
      .writeHead(200, { "content-type": "text/event-stream" })
      .end("data: " + body + "\n\n");
  return res.writeHead(200, { "content-type": "application/json" }).end(body);
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
process.env.GOOGLE_GEMINI_BASE_URL = "http://127.0.0.1:" + model.address().port;
const config = readConfig({
  ...process.env,
  CLAUDEX_WEB_CONFIG_DIR: root,
  CODEX_HOME: join(root, "codex"),
  CLAUDE_CONFIG_DIR: join(root, "claude"),
  DEFAULT_CWD: cwd,
  HOST: "127.0.0.1",
  PORT: "0",
});
const settings = createBackendConfiguration(config);
for (const id of ["codex", "claude", "agy"])
  await settings.save({
    id,
    type: id,
    enabled: id === "agy",
    ...(id === "agy" && { executable, proxy: { mode: "off" } }),
  });

const auth = await authenticationFixture(root);
const socket = workerLocation(join(root, "backends", "agy")).socket;
const state = async () =>
  JSON.parse(
    await readFile(join(root, "backends", "agy", "state.json"), "utf8"),
  );
const evidence = { version, prompts, operations: [], native: {}, layout: [] };
let app, context, page, port;

async function launchBridge() {
  app = createWebApplication({
    config: { ...config, port: port || 0 },
    tls: auth.tls,
    authentication: await createAuthentication(config),
    version: { version: "4.2.3", displayVersion: "4.2.3" },
  });
  await app.start();
  port = app.server.address().port;
}

async function stopWorker() {
  const peer = await connectIpc(socket);
  try {
    const snapshot = await peer.call("state");
    const closed = once(peer.socket, "close");
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        await peer.call("shutdown");
        break;
      } catch (error) {
        if (
          Date.now() >= deadline ||
          !error.message.includes("仍有执行中的会话或委派任务")
        )
          throw error;
        await delay(200);
      }
    }
    await closed;
    while (Date.now() < deadline) {
      try {
        process.kill(snapshot.params.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") return snapshot.params.pid;
        throw error;
      }
      await delay(100);
    }
    throw new Error("隔离 agy Worker 未退出");
  } finally {
    peer.close();
  }
}

async function nativeList(label) {
  const client = createAcpClient({
    executable,
    cwd,
    agent: "default",
    proxy: { mode: "off" },
  });
  try {
    const init = await client.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    assert.equal(init.agentInfo.version, version);
    const { sessions } = await client.call("session/list", { cwd });
    evidence.native[label] = sessions;
    return sessions;
  } finally {
    client.close();
    await client.exited;
  }
}

const liveDb = (id) => join(profile, "conversations", id + ".db");
const parkedDb = (id) =>
  join(profile, ".claudex-history", "archived", id + ".db");
const status = (id) => {
  const database = new DatabaseSync(
    join(profile, "conversation_summaries.db"),
    { readOnly: true },
  );
  try {
    return database
      .prepare(
        "SELECT title, preview FROM conversation_summaries WHERE conversation_id = ?",
      )
      .get(id);
  } finally {
    database.close();
  }
};
const hash = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const absent = (file) => assert.rejects(readFile(file), { code: "ENOENT" });

try {
  await launchBridge();
  const url = "https://127.0.0.1:" + port;
  context = await chromium.launchPersistentContext(join(root, "browser"), {
    executablePath: process.env.CHROME_PATH,
    args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
    ignoreHTTPSErrors: true,
    viewport: { width: 1400, height: 920 },
    colorScheme: "light",
  });
  await context.addCookies([
    {
      name: "__Host-claudex-web-session",
      value: auth.cookie.split("=")[1],
      url,
      httpOnly: true,
    },
  ]);
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  const screenshot = (name) =>
    page.screenshot({
      path: join(output, name + ".png"),
      animations: "disabled",
    });
  page.on("websocket", (ws) => {
    const requests = new Set();
    for (const direction of ["framesent", "framereceived"]) {
      ws.on(direction, ({ payload }) => {
        if (typeof payload !== "string") return;
        const packet = JSON.parse(payload);
        const history = /^thread\/(?:name\/|archiv|unarchiv|delet)/.test(
          packet.method || "",
        );
        if (history && direction === "framesent") requests.add(packet.id);
        if (
          history ||
          (direction === "framereceived" && requests.has(packet.id))
        )
          evidence.operations.push({ direction, ...packet });
      });
    }
  });
  await page.goto(url);
  const button = (name, surface = page) =>
    surface.getByRole("button", { name, exact: true });
  const sidebar = page.locator("#project-sidebar");
  const title = (name) =>
    sidebar.locator(".thread-row").getByText(name, { exact: true });
  const hover = async (name) => {
    const group = sidebar.getByRole("button", { name: /^workspace/ });
    await title(name).or(group).first().waitFor();
    if (!(await title(name).isVisible())) {
      await group.click();
    }
    await title(name).hover();
  };
  async function send(message, answer) {
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill(message);
    await button("发送消息").click();
    await page.getByText(answer, { exact: true }).waitFor();
    await button("停止任务").waitFor({ state: "hidden" });
  }
  const menu = async (name) => {
    await hover(name);
    await button("管理对话 " + name, sidebar).click();
  };
  const rename = async (before, after) => {
    await menu(before);
    await button("重命名").click();
    await page.getByLabel("对话名称").fill(after);
    await button("保存").click();
    await title(after).waitFor();
  };
  await page.getByRole("heading", { name: /今天想完成什么/ }).waitFor();
  await send("这是保留会话，用于校验其他历史。", "对照记录完整。");
  const [control] = Object.values((await state()).sessions);
  const controlName = "保留对照历史";
  await rename(control.name || "新对话", controlName);
  await sidebar.getByRole("button", { name: /^新对话/ }).click();
  await send("这是待改名、归档和删除的隔离会话。", "目标记录已保存。");
  const target = Object.values((await state()).sessions).find(
    ({ id }) => id !== control.id,
  );
  assert(target.nativeId);
  assert(control.nativeId);
  assert.equal((await nativeList("before")).length, 2);
  const controlHash = await hash(liveDb(control.nativeId));
  const targetHash = await hash(liveDb(target.nativeId));

  const initialName = target.name || "新对话";
  const renamed = '发布记录「备忘」 "2026"';
  await rename(initialName, renamed);
  assert.equal(
    (await nativeList("renamed")).find(
      ({ sessionId }) => sessionId === target.nativeId,
    ).title,
    renamed,
  );
  assert.equal(await hash(liveDb(target.nativeId)), targetHash);
  await screenshot("renamed-light");
  await page.reload();
  await hover(renamed);
  assert.equal(
    (await nativeList("reloaded")).find(
      ({ sessionId }) => sessionId === target.nativeId,
    ).title,
    renamed,
  );

  await hover(renamed);
  await button("归档对话 " + renamed, sidebar).click();
  await title(renamed).waitFor({ state: "hidden" });
  assert.deepEqual(
    (await nativeList("archived")).map(({ sessionId }) => sessionId),
    [control.nativeId],
  );
  await absent(liveDb(target.nativeId));
  assert.equal(await hash(parkedDb(target.nativeId)), targetHash);
  console.log("网页改名、刷新与原生归档通过");

  await page.goto("about:blank");
  const oldPid = await stopWorker();
  console.log("隔离 agy Worker 已退出");
  await app.close();
  app = undefined;
  console.log("隔离网页桥接已退出");
  await launchBridge();
  const worker = await connectIpc(socket);
  try {
    const snapshot = await worker.call("state");
    assert.notEqual(snapshot.params.pid, oldPid);
    evidence.workerRecreated = snapshot.params.ready;
    assert.equal(snapshot.params.ready, true);
  } finally {
    worker.close();
  }
  await page.goto(url);
  await button("查看归档对话", sidebar).click();
  await hover(renamed);
  assert.deepEqual(
    (await nativeList("bridgeAndWorkerRestarted")).map(
      ({ sessionId }) => sessionId,
    ),
    [control.nativeId],
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await screenshot("archive-dark");
  await button("恢复对话 " + renamed, sidebar).click();
  await page.getByText("目标记录已保存。", { exact: true }).waitFor();
  assert.equal(
    (await nativeList("restored")).find(
      ({ sessionId }) => sessionId === target.nativeId,
    ).title,
    renamed,
  );
  await absent(parkedDb(target.nativeId));

  await page.setViewportSize({ width: 390, height: 844 });
  await button("显示侧栏").click();
  await menu(renamed);
  await button("删除对话").click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByText("当前 Antigravity 原生会话也将永久删除。项目文件会保留。")
    .waitFor();
  await screenshot("delete-confirm-mobile-dark");
  await button("取消", dialog).click();
  await title(renamed).waitFor();
  await menu(renamed);
  await button("删除对话").click();
  await button("删除对话", dialog).click();
  await dialog.waitFor({ state: "hidden" });
  await title(renamed).waitFor({ state: "hidden" });

  for (const file of [
    liveDb(target.nativeId),
    liveDb(target.nativeId) + "-wal",
    liveDb(target.nativeId) + "-shm",
    parkedDb(target.nativeId),
    join(profile, "annotations", target.nativeId + ".pbtxt"),
    join(
      profile,
      "brain",
      target.nativeId,
      ".system_generated/logs/transcript.jsonl",
    ),
  ])
    await absent(file);
  assert.equal(status(target.nativeId), undefined);
  for (const path of [
    "jetbox_summaries_proto.pb",
    "cache/conversation_metadata.json",
    "cache/last_conversations.json",
  ]) {
    const content = await readFile(join(profile, path)).catch((error) => {
      if (error.code === "ENOENT") return Buffer.alloc(0);
      throw error;
    });
    assert(!content.includes(target.nativeId), path);
  }
  assert.deepEqual(
    (await nativeList("deleted")).map(({ sessionId }) => sessionId),
    [control.nativeId],
  );
  assert.equal(await hash(liveDb(control.nativeId)), controlHash);
  assert.equal((await state()).sessions[target.id].deleted, true);
  evidence.deletedIndex = true;
  evidence.controlHistoryUnchanged = controlHash;
  if (await button("显示侧栏").isVisible()) await button("显示侧栏").click();
  await hover(controlName);
  await page.emulateMedia({ colorScheme: "light" });
  await screenshot("deleted-mobile-light");
  await button("收起侧栏", sidebar).click();
  await page.waitForFunction(
    () =>
      !document
        .querySelector("#project-sidebar")
        .contains(document.activeElement),
  );

  const appearance = await context.newPage();
  await appearance.goto("chrome://settings/appearance");
  for (const width of [390, 1400]) {
    await page.setViewportSize({ width, height: 844 });
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
        await appearance.locator("#zoomLevel").selectOption(String(scale));
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
        );
        evidence.layout.push({ width, colorScheme, scale, ...geometry });
      }
      await appearance.locator("#zoomLevel").selectOption("1");
    }
  }
  await appearance.close();
  assert.equal(prompts.length, 2);
  console.log(
    JSON.stringify({
      version,
      operations: evidence.operations.length,
      nativeListChecks: Object.keys(evidence.native),
      workerRecreated: evidence.workerRecreated,
      controlHash,
      layout: evidence.layout.length,
    }),
  );
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  const workerLog = await readFile(
    join(root, "backends/agy/worker.log"),
    "utf8",
  ).catch(() => "");
  if (workerLog) await writeFile(join(output, "worker.log"), workerLog);
  throw error;
} finally {
  await writeFile(
    join(output, "evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await context?.close();
  await app?.close();
  await stopWorker().catch(() => {});
  await new Promise((resolve) => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}

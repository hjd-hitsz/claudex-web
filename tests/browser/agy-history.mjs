import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { authenticationFixture } from "../helpers/auth.mjs";
import { createWebApplication } from "../../server/src/application.mjs";
import { createAuthentication } from "../../server/src/auth.mjs";
import { createBackendConfiguration } from "../../server/src/backends/configuration.mjs";
import {
  connectIpc,
  workerLocation,
} from "../../server/src/backends/agy/worker-ipc.mjs";
import { readConfig } from "../../server/src/config.mjs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { savedAgyAgent } from "../../server/src/backends/agy/native-agent.mjs";

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const realAgy =
  process.env.AGY_EXECUTABLE ||
  execFileSync("which", ["agy"], { encoding: "utf8" }).trim();
const version = execFileSync(realAgy, ["--version"], {
  encoding: "utf8",
}).trim();
const root = await mkdtemp(join(tmpdir(), "claudex-agy-history-"));
const output = resolve(process.env.AGY_HISTORY_OUTPUT || ".cache/agy-history");
const cwd = join(root, "workspace");
const home = join(root, "home");
const bin = join(root, "bin");
const profile = join(home, ".gemini", "antigravity-cli");
await Promise.all(
  [cwd, bin, profile, output].map((path) => mkdir(path, { recursive: true })),
);
await writeFile(
  join(profile, "settings.json"),
  JSON.stringify({
    modelProvider: "gemini",
    auth: { type: "gemini-api-key" },
  }),
);
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
await writeFile(
  join(bin, "agy"),
  `#!/bin/sh\nexec ${quote(realAgy)} "$@" --disable-telemetry\n`,
  { mode: 0o700 },
);
await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
Object.assign(process.env, {
  HOME: home,
  XDG_RUNTIME_DIR: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  PATH: bin + ":" + process.env.PATH,
  GEMINI_API_KEY: "isolated-agy-history",
});
delete process.env.DBUS_SESSION_BUS_ADDRESS;
const first = "保留轮次：请读取隔离项目的标记。";
const second = "中间轮次：原始的蓝色方案。";
const third = "尾部轮次：仅在原会话讨论紫色方案。";
const continued = "分支新问题：请回顾标记和蓝色方案。";
const edited = "编辑后的新问题：请改为绿色方案。";
const firstAnswer = "项目标记已读取。";
const secondAnswer = "蓝色方案已记录。";
const thirdAnswer = "紫色方案已记录。";
const branchAnswer = "已在分支中回顾项目标记和蓝色方案。";
const editAnswer = "已基于项目标记改为绿色方案。";
const toolMarker = "AGY_HISTORY_TOOL_RESULT_831";
const markerPath = join(cwd, "history-marker.txt");
await writeFile(markerPath, toolMarker);
const requests = [];
const events = [];
const thirdEntered = Promise.withResolvers();
const releaseThird = Promise.withResolvers();
const model = createServer(async (req, res) => {
  if (req.method === "GET") return res.end('{"models":[]}');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks));
  const { contents, systemInstruction } = request;
  const title = JSON.stringify(systemInstruction).includes(
    "conversation title generator",
  );
  const lastText =
    contents
      .at(-1)
      ?.parts.filter(({ text }) => text)
      .at(-1)?.text ?? "";
  const kind = title
    ? "title"
    : ([
        [continued, "branch"],
        [edited, "edit"],
        [third, "third"],
        [second, "second"],
        [first, "first"],
      ].find(([text]) => lastText.includes(text))?.[1] ?? "toolResult");
  const pathname = new URL(req.url, "http://localhost").pathname;
  requests.push({ kind, pathname, ...request });
  if (kind === "third") {
    thirdEntered.resolve();
    await releaseThird.promise;
  }
  const answers = {
    title: "隔离项目讨论",
    toolResult: firstAnswer,
    second: secondAnswer,
    third: thirdAnswer,
    branch: branchAnswer,
    edit: editAnswer,
  };
  const parts =
    kind === "first"
      ? [{ functionCall: { name: "read_file", args: { Path: markerPath } } }]
      : [{ text: answers[kind] }];
  const response = JSON.stringify({
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 120,
      candidatesTokenCount: 16,
      totalTokenCount: 136,
    },
  });
  if (pathname.includes("streamGenerateContent"))
    return res
      .writeHead(200, { "content-type": "text/event-stream" })
      .end("data: " + response + "\n\n");
  res.writeHead(200, { "content-type": "application/json" }).end(response);
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
process.env.GOOGLE_GEMINI_BASE_URL = "http://127.0.0.1:" + model.address().port;
const config = {
  ...readConfig({
    ...process.env,
    CLAUDEX_WEB_CONFIG_DIR: root,
    CODEX_HOME: join(root, "codex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    DEFAULT_CWD: cwd,
    HOST: "127.0.0.1",
    PORT: "0",
  }),
};
const settings = createBackendConfiguration(config);
for (const id of ["codex", "claude", "agy"])
  await settings.save({
    id,
    type: id,
    enabled: id === "agy",
    ...(id === "agy" && { proxy: { mode: "off" } }),
  });
const auth = await authenticationFixture(root);
const app = createWebApplication({
  config,
  tls: auth.tls,
  authentication: await createAuthentication(config),
  version: { version: "4.2.3", displayVersion: "4.2.3" },
});
const state = async () =>
  JSON.parse(
    await readFile(join(root, "backends", "agy", "state.json"), "utf8"),
  );
function nativeHistory(nativeId) {
  const db = new DatabaseSync(
    join(profile, "conversations", nativeId + ".db"),
    { readOnly: true },
  );
  try {
    const rows = db
      .prepare(
        "SELECT idx, step_type, status, hex(step_payload) AS payload FROM steps ORDER BY idx",
      )
      .all();
    return {
      steps: rows.length,
      sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    };
  } finally {
    db.close();
  }
}
const evidence = { version, requests, events };
let context;
let worker;
let page;
try {
  await app.start();
  const url = "https://127.0.0.1:" + app.server.address().port;
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
  page.on("websocket", (socket) => {
    for (const direction of ["framereceived", "framesent"])
      socket.on(direction, ({ payload }) => {
        if (typeof payload !== "string") return;
        const packet = JSON.parse(payload);
        if (
          [
            "thread/fork",
            "thread/revert",
            "thread/reverted",
            "turn/start",
            "turn/started",
            "turn/completed",
            "item/completed",
          ].includes(packet.method)
        )
          events.push({ direction, ...packet });
      });
  });
  const screenshot = (name) =>
    page.screenshot({
      path: join(output, name + ".png"),
      animations: "disabled",
    });
  page.setDefaultTimeout(12000);
  await page.goto(url);
  await page.getByRole("heading", { name: /今天想完成什么/ }).waitFor();
  const box = page.getByRole("textbox", { name: "消息", exact: true });
  const send = async (text) => {
    await box.fill(text);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
  };
  const text = (value) => page.getByText(value, { exact: true });
  const stop = page.getByRole("button", { name: "停止任务", exact: true });
  const settled = async (answer) => {
    await text(answer).waitFor();
    await stop.waitFor({ state: "hidden" });
  };
  await send(first);
  await settled(firstAnswer);
  await send(second);
  await settled(secondAnswer);
  await send(third);
  await thirdEntered.promise;
  const sourceId = Object.keys((await state()).sessions)[0];
  const busy = (await state()).sessions[sourceId];
  worker = await connectIpc(
    workerLocation(join(root, "backends", "agy")).socket,
  );
  const rpc = (method, params) =>
    worker.call("rpc", { method, params: { threadId: sourceId, ...params } });
  await assert.rejects(
    rpc("thread/fork", { lastTurnId: busy.turns[1].id }),
    /轮次结束/,
  );
  await assert.rejects(
    rpc("thread/revert", { beforeTurnId: busy.turns[1].id }),
    /轮次结束/,
  );
  evidence.busyRejected = true;
  releaseThird.resolve();
  await settled(thirdAnswer);
  const sourceName = "历史改写验收";
  await rpc("thread/name/set", { name: sourceName });
  const source = (await state()).sessions[sourceId];
  const originalHistory = nativeHistory(source.nativeId);
  const sourceResource = "backend:agy:" + sourceId;
  const currentResource = () =>
    page.evaluate(() => localStorage.getItem("cx-current"));
  assert.equal(await currentResource(), sourceResource);
  const beforeFork = requests.filter(({ kind }) => kind !== "title").length;
  const reply = text(secondAnswer).locator(
    "xpath=ancestor::*[contains(@class,'assistant-message')]",
  );
  await reply.hover();
  const forkButton = page
    .getByRole("button", { name: "从这里继续", exact: true })
    .nth(1);
  await forkButton.click();
  await page.waitForFunction(
    (source) => localStorage.getItem("cx-current") !== source,
    sourceResource,
  );
  await text(secondAnswer).waitFor();
  assert.equal(await text(third).count(), 0);
  assert.equal(await text(thirdAnswer).count(), 0);
  const branch = Object.values((await state()).sessions).find(
    ({ id }) => id !== sourceId,
  );
  assert(branch.nativeId);
  assert.notEqual(branch.nativeId, source.nativeId);
  assert.equal(
    await savedAgyAgent(branch.nativeId, profile),
    "claudex-secretary",
  );
  assert.deepEqual(branch.turns, source.turns.slice(0, 2));
  assert.equal(branch.model, source.model);
  assert.equal(branch.effort, source.effort);
  assert.deepEqual((await state()).sessions[sourceId], source);
  assert.equal(
    requests.filter(({ kind }) => kind !== "title").length,
    beforeFork,
  );
  const branchResource = "backend:agy:" + branch.id;
  assert.equal(await currentResource(), branchResource);
  await screenshot("branch-prefix-light");
  await page.reload();
  await text(secondAnswer).waitFor();
  assert.equal(
    requests.filter(({ kind }) => kind !== "title").length,
    beforeFork,
  );
  await send(continued);
  await settled(branchAnswer);
  await page.emulateMedia({ colorScheme: "dark" });
  await screenshot("branch-completed-dark");
  await page.reload();
  await text(firstAnswer).waitFor();
  await text(branchAnswer).waitFor();
  assert.equal(await currentResource(), branchResource);
  assert.equal((await state()).sessions[branch.id].nativeId, branch.nativeId);
  assert.equal(await text(third).count(), 0);

  await page.emulateMedia({ colorScheme: "light" });
  const sourceEntry = page
    .locator("#project-sidebar")
    .getByText(sourceName, { exact: true });
  if (!(await sourceEntry.isVisible()))
    await page
      .locator("#project-sidebar")
      .getByText("workspace", { exact: true })
      .click();
  await sourceEntry.click();
  await text(thirdAnswer).waitFor();
  const secondMessage = page
    .locator(".user-message")
    .filter({ hasText: second });
  await secondMessage.hover();
  await secondMessage
    .getByRole("button", { name: "编辑消息", exact: true })
    .click();
  const editor = page.locator(".user-message-editor");
  await editor.getByRole("textbox", { name: "编辑消息" }).fill(edited);
  await screenshot("edit-light");
  await editor.getByRole("button", { name: "发送", exact: true }).click();
  await settled(editAnswer);
  assert.equal(await currentResource(), sourceResource);
  assert.equal(await text(second).count(), 0);
  assert.equal(await text(third).count(), 0);
  assert.equal(await text(secondAnswer).count(), 0);
  assert.equal(await text(thirdAnswer).count(), 0);
  const saved = (await state()).sessions[sourceId];
  assert.equal(saved.previousNativeId, source.nativeId);
  assert.notEqual(saved.nativeId, source.nativeId);
  assert.notEqual(saved.nativeId, branch.nativeId);
  assert.equal(
    await savedAgyAgent(saved.nativeId, profile),
    "claudex-secretary",
  );
  assert.equal(saved.model, source.model);
  assert.equal(saved.effort, source.effort);
  assert.equal(saved.turns.length, 2);
  assert.deepEqual(saved.turns[0], source.turns[0]);
  assert.equal(saved.turns[1].status, "completed");
  assert.equal(saved.turns[1].items[0].content[0].text, edited);
  assert(!saved.historyReplay);
  const preservedHistory = nativeHistory(source.nativeId);
  assert.deepEqual(preservedHistory, originalHistory);
  evidence.mapping = {
    source,
    branch,
    edited: saved,
    originalHistory,
    preservedHistory,
  };

  const nonTitle = requests.filter(({ kind }) => kind !== "title");
  assert.deepEqual(
    nonTitle.map(({ kind }) => kind),
    ["first", "toolResult", "second", "third", "branch", "edit"],
  );
  for (const [kind, included, excluded] of [
    [
      "branch",
      [first, firstAnswer, second, secondAnswer, continued],
      [third, thirdAnswer, edited],
    ],
    [
      "edit",
      [first, firstAnswer, edited],
      [second, secondAnswer, third, thirdAnswer, continued],
    ],
  ]) {
    const request = nonTitle.find((request) => request.kind === kind);
    const contents = JSON.stringify(request.contents);
    for (const value of [...included, toolMarker, "read_file"])
      assert(contents.includes(value), kind + " 缺少 " + value);
    for (const value of excluded)
      assert(!contents.includes(value), kind + " 带入 " + value);
    assert(
      request.contents.every(({ parts }) =>
        parts.every(
          ({ functionCall, functionResponse }) =>
            !functionCall && !functionResponse,
        ),
      ),
    );
    assert(JSON.stringify(request.tools).includes("read_delegation_step"));
    assert(
      JSON.stringify(request.systemInstruction).includes("<Claudex secretary>"),
    );
    assert.equal(request.pathname, nonTitle[0].pathname);
    assert.deepEqual(
      request.generationConfig.thinkingConfig,
      nonTitle[0].generationConfig.thinkingConfig,
    );
  }
  const completed = events.filter(({ method }) => method === "turn/completed");
  assert.equal(completed.length, 5);
  assert(completed.every(({ params }) => params.turn.status === "completed"));
  assert.equal(new Set(completed.map(({ params }) => params.turn.id)).size, 5);
  assert.deepEqual(
    completed.map(({ params }) => params.turn.id),
    [
      ...source.turns.map(({ id }) => id),
      (await state()).sessions[branch.id].turns.at(-1).id,
      saved.turns[1].id,
    ],
  );
  assert(
    completed
      .slice(-2)
      .every(({ params }) =>
        params.turn.items.every(({ type }) => type !== "mcpToolCall"),
      ),
  );

  const browserSettings = await context.newPage();
  await browserSettings.goto("chrome://settings/appearance");
  const zoom = browserSettings.locator("#zoomLevel");
  const layout = [];
  await page.reload();
  await text(editAnswer).waitFor();
  await text(firstAnswer).waitFor();
  assert.equal((await state()).sessions[sourceId].nativeId, saved.nativeId);
  assert.equal(await currentResource(), sourceResource);
  assert.equal(await text(second).count(), 0);
  assert.equal(await text(third).count(), 0);
  await screenshot("edit-restored-light");
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
        layout.push({ width, colorScheme, scale, ...geometry });
      }
      await zoom.selectOption("1");
      if (width === 390)
        await screenshot("edit-restored-mobile-" + colorScheme);
    }
  }
  await browserSettings.close();
  await page.getByRole("button", { name: "显示侧栏", exact: true }).click();
  await screenshot("restored-mobile-sidebar");
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await page.waitForFunction(
    () =>
      !document
        .querySelector("#project-sidebar")
        .contains(document.activeElement),
  );
  evidence.layout = layout;
  console.log(
    JSON.stringify({
      version,
      firstModelRequests: ["branch", "edit"],
      completedTurns: completed.length,
      unchangedNativeHistory: originalHistory,
      layoutChecks: layout.length,
      output,
    }),
  );
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await writeFile(
    join(output, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  releaseThird.resolve();
  await context?.close();
  worker ??= await connectIpc(
    workerLocation(join(root, "backends", "agy")).socket,
  ).catch(() => null);
  if (worker) {
    await worker.call("shutdown").catch(() => {});
    worker.close();
  }
  await app.close();
  model.close();
  await rm(root, { recursive: true, force: true });
}

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

const before = Boolean(process.env.AGY_STEER_BEFORE);
const textOnly = process.env.AGY_STEER_TEXT === "1";
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const realAgy =
  process.env.AGY_EXECUTABLE ||
  execFileSync("which", ["agy"], { encoding: "utf8" }).trim();
const root = await mkdtemp(join(tmpdir(), "claudex-steer-"));
const output = resolve(
  process.env.AGY_STEER_OUTPUT || ".cache/agy-steer",
  before ? "before" : textOnly ? "after-text" : "after",
);
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
  GEMINI_API_KEY: "isolated-agy-steer",
});
delete process.env.DBUS_SESSION_BUS_ADDRESS;
const first = textOnly
  ? "请写一段欢迎词。"
  : "请先读取项目标记，再按原计划写一段总结。";
const partial = textOnly
  ? "欢迎大家参与今天的讨论。"
  : "已开始检查项目，接下来读取项目标记。";
const originalTail = "我们马上开始。";
const nextPartial = "Bienvenidos a la conversación.";
const supplement = "补充：请按西班牙语总结。";
const toolMarker = "STEER_TOOL_RESULT_174";
const markerPath = join(cwd, "project-marker.txt");
await writeFile(markerPath, toolMarker);
const steered = textOnly
  ? "Gracias por participar."
  : "Marcador leído. Resumen en español.";
const lost = "Marcador no leído. Volviendo a empezar.";
const releaseTool = Promise.withResolvers();
const releaseAnswer = Promise.withResolvers();
const receivedSupplement = Promise.withResolvers();
const requests = [];
const events = [];
const started = performance.now();
const clock = () => Math.round(performance.now() - started);
const model = createServer(async (req, res) => {
  if (req.method === "GET") return res.end('{"models":[]}');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const { contents, systemInstruction } = JSON.parse(Buffer.concat(chunks));
  const title = JSON.stringify(systemInstruction).includes(
    "conversation title generator",
  );
  const serialized = JSON.stringify(contents);
  const hasSupplement = serialized.includes(supplement);
  const hasResult = contents.some(({ parts }) =>
    parts.some(
      ({ functionResponse }) =>
        functionResponse &&
        JSON.stringify(functionResponse.response).includes(toolMarker),
    ),
  );
  requests.push({ ms: clock(), title, hasSupplement, hasResult, contents });
  const payload = (parts, finishReason) =>
    JSON.stringify({
      candidates: [{ content: { role: "model", parts }, finishReason }],
      usageMetadata: {
        promptTokenCount: 150,
        candidatesTokenCount: 10,
        totalTokenCount: 160,
      },
    });
  if (!req.url.includes("streamGenerateContent"))
    return res
      .writeHead(200, { "content-type": "application/json" })
      .end(payload([{ text: "项目标记检查" }], "STOP"));
  res.writeHead(200, { "content-type": "text/event-stream" });
  const packet = (parts, finishReason) =>
    "data: " + payload(parts, finishReason) + "\n\n";
  if (title) return res.end(packet([{ text: "项目标记检查" }], "STOP"));
  if (!hasSupplement && !hasResult) {
    res.write(packet([{ text: partial }]));
    res.once("close", () =>
      events.push({
        ms: clock(),
        event: "initial model stream closed",
        ended: res.writableEnded,
      }),
    );
    await releaseTool.promise;
    if (res.destroyed) return;
    if (textOnly) {
      events.push({ ms: clock(), event: "initial text STOP sent" });
      return res.end(packet([{ text: originalTail }], "STOP"));
    }
    return res.end(
      packet(
        [
          {
            functionCall: {
              name: "read_file",
              args: { Path: markerPath },
            },
          },
        ],
        "STOP",
      ),
    );
  }
  if (hasSupplement) {
    if (textOnly) res.write(packet([{ text: nextPartial }]));
    receivedSupplement.resolve();
  }
  await releaseAnswer.promise;
  if (textOnly) {
    events.push({ ms: clock(), event: "supplement text STOP sent" });
    return res.end(packet([{ text: " " + steered }], "STOP"));
  }
  res.end(
    packet(
      [
        {
          text: hasSupplement
            ? hasResult
              ? steered
              : lost
            : "原任务独立结束。",
        },
      ],
      "STOP",
    ),
  );
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
  ...(before && { staticDir: resolve(process.env.AGY_STEER_BEFORE) }),
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
let context;
try {
  await app.start();
  const url = "https://127.0.0.1:" + app.server.address().port;
  context = await chromium.launchPersistentContext(join(root, "browser"), {
    executablePath: process.env.CHROME_PATH,
    args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
    ignoreHTTPSErrors: true,
    viewport: { width: 1400, height: 900 },
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
  const page = await context.newPage();
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const packet = JSON.parse(payload);
      if (
        [
          "turn/started",
          "turn/completed",
          "item/started",
          "item/completed",
        ].includes(packet.method)
      )
        events.push({
          ms: clock(),
          event: packet.method,
          params: packet.params,
        });
    });
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const packet = JSON.parse(payload);
      if (packet.method === "turn/steer")
        events.push({
          ms: clock(),
          event: packet.method,
          params: packet.params,
        });
    });
  });
  const screenshot = (name) =>
    page.screenshot({
      path: join(output, name + ".png"),
      animations: "disabled",
    });
  page.setDefaultTimeout(15000);
  await page.goto(url);
  await page.getByRole("heading", { name: /今天想完成什么/ }).waitFor();
  const box = page.getByRole("textbox", { name: "消息", exact: true });
  const send = async (text) => {
    await box.fill(text);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
  };
  await send(first);
  await page.getByText(partial, { exact: true }).waitFor();
  await screenshot("generating");
  await send(supplement);
  const stop = page.getByRole("button", { name: "停止任务", exact: true });
  if (!before) {
    await page.getByText(supplement, { exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".cm-content")
          ?.textContent.includes("按西班牙语"),
    );
    await screenshot("steer-accepted-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await page.getByText(supplement, { exact: true }).waitFor();
    await stop.waitFor();
    if (textOnly) {
      assert.equal(requests.filter(({ title }) => !title).length, 1);
      assert.equal(
        events.filter(({ event }) => event === "turn/completed").length,
        0,
      );
    }
    await screenshot("steer-accepted-dark");
    await page.setViewportSize({ width: 390, height: 900 });
    const closeSidebar = page.getByRole("button", {
      name: "收起侧栏",
      exact: true,
    });
    const openSidebar = page.getByRole("button", {
      name: "显示侧栏",
      exact: true,
    });
    await openSidebar.click();
    await closeSidebar.focus();
    await closeSidebar.click();
    await page.waitForFunction(
      () => !document.activeElement?.closest("#project-sidebar"),
    );
    await openSidebar.waitFor();
    await screenshot("steer-accepted-mobile");
    const preferences = await context.newPage();
    await preferences.goto("chrome://settings/appearance");
    const zoom = preferences.locator("#zoomLevel");
    const layout = [];
    for (const width of [390, 1400]) {
      await page.setViewportSize({ width, height: 900 });
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, colorScheme);
        for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
          await zoom.selectOption(String(scale));
          await page.waitForFunction(
            (scale) => Math.abs(devicePixelRatio - scale) < 0.02,
            scale,
          );
          const geometry = await stop.evaluate((element) => ({
            dpr: devicePixelRatio,
            viewport: innerWidth,
            scroll: document.documentElement.scrollWidth,
            left: element.getBoundingClientRect().left,
            right: element.getBoundingClientRect().right,
          }));
          assert(
            Math.abs(geometry.viewport - width / scale) <= 1,
            JSON.stringify(geometry),
          );
          assert(
            geometry.scroll <= geometry.viewport + 1,
            JSON.stringify(geometry),
          );
          assert(
            geometry.left >= 0 && geometry.right <= geometry.viewport + 1,
            JSON.stringify(geometry),
          );
          layout.push({ width, colorScheme, scale, ...geometry });
        }
      }
    }
    await zoom.selectOption("1");
    await preferences.close();
    await writeFile(
      join(output, "layout.json"),
      JSON.stringify(layout, null, 2),
    );
    await page.setViewportSize({ width: 1400, height: 900 });
    releaseTool.resolve();
  }
  await Promise.race([
    receivedSupplement.promise,
    new Promise((_, reject) =>
      AbortSignal.timeout(15000).addEventListener(
        "abort",
        () => reject(new Error("模型未收到补充说明")),
        { once: true },
      ),
    ),
  ]);
  releaseTool.resolve();
  if (!before) {
    await page.reload();
    await page.getByText(supplement, { exact: true }).waitFor();
    await stop.waitFor();
    if (textOnly) {
      await page.getByText(nextPartial, { exact: true }).waitFor();
      await page.getByText(partial + originalTail, { exact: true }).waitFor();
      await screenshot("text-continuing");
    }
    assert.equal(
      events.filter(({ event }) => event === "turn/completed").length,
      0,
    );
  }
  releaseAnswer.resolve();
  const answer = before ? lost : steered;
  const finalAnswer = textOnly ? nextPartial + " " + answer : answer;
  await page.getByText(finalAnswer, { exact: true }).waitFor();
  await stop.waitFor({ state: "hidden" });
  await screenshot("result");
  const modelTurns = requests.filter(({ title }) => !title);
  assert.equal(modelTurns.length, 2);
  assert.equal(modelTurns[1].hasResult, !before && !textOnly);
  assert.equal(modelTurns[1].hasSupplement, true);
  assert.equal(
    JSON.stringify(modelTurns[1].contents).includes(partial),
    !before,
  );
  const completed = events.filter(({ event }) => event === "turn/completed");
  assert.deepEqual(
    completed.map(({ params }) => params.turn.status),
    before ? ["interrupted", "completed"] : ["completed"],
  );
  if (!before) {
    const [
      {
        params: { turn },
      },
    ] = completed;
    assert.equal(
      events.find(({ event }) => event === "turn/steer").params.expectedTurnId,
      turn.id,
    );
    assert.equal(
      turn.items.filter(({ content }) => content?.[0]?.text === supplement)
        .length,
      1,
    );
    if (textOnly) {
      assert(
        modelTurns.every(({ contents }) =>
          contents.every(({ parts }) =>
            parts.every(
              ({ functionCall, functionResponse }) =>
                !functionCall && !functionResponse,
            ),
          ),
        ),
      );
      assert(JSON.stringify(modelTurns[1].contents).includes(originalTail));
      const terminalSignal = events.find(
        ({ event }) => event === "supplement text STOP sent",
      );
      assert(terminalSignal.ms <= completed[0].ms);
      assert.equal(
        turn.items.filter(({ type }) => type === "agentMessage").length,
        1,
      );
      assert(
        turn.items.some(({ text }) => text?.includes(partial + originalTail)),
      );
    } else {
      assert.equal(turn.items.filter(({ text }) => text === partial).length, 1);
    }
    await page.reload();
    await page.getByText(finalAnswer, { exact: true }).waitFor();
    assert.equal(await page.getByText(supplement, { exact: true }).count(), 1);
    if (textOnly) {
      await page.getByText(partial + originalTail, { exact: true }).waitFor();
    } else {
      await page.locator(".process-history > summary").click();
      await page.getByText(partial, { exact: true }).waitFor();
      assert.equal(await page.getByText(partial, { exact: true }).count(), 1);
    }
    await screenshot("restored");
  }
  console.log(
    JSON.stringify({
      before,
      textOnly,
      modelRequests: modelTurns.length,
      output,
    }),
  );
} finally {
  releaseTool.resolve();
  releaseAnswer.resolve();
  await writeFile(
    join(output, "timeline.json"),
    JSON.stringify({ requests, events }, null, 2),
  );
  await context?.close();
  const worker = await connectIpc(
    workerLocation(join(root, "backends", "agy")).socket,
  ).catch(() => null);
  await worker?.call("shutdown").catch(() => {});
  worker?.close();
  await app.close();
  model.closeAllConnections();
  model.close();
  await rm(root, { recursive: true, force: true });
}

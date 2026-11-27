import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWebApplication } from "../../server/src/application.mjs";
import { createAuthentication } from "../../server/src/auth.mjs";
import { createBackendConfiguration } from "../../server/src/backends/configuration.mjs";
import {
  connectIpc,
  workerLocation,
} from "../../server/src/backends/agy/worker-ipc.mjs";
import { readConfig } from "../../server/src/config.mjs";
import { authenticationFixture } from "../helpers/auth.mjs";

const before = process.env.BROWSER_BEFORE === "1";
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const agy =
  process.env.AGY_EXECUTABLE ||
  execFileSync("which", ["agy"], { encoding: "utf8" }).trim();
const version = execFileSync(agy, ["--version"], { encoding: "utf8" }).trim();
const root = await mkdtemp(join(tmpdir(), "claudex-agy-presentation-"));
const output = resolve(".cache/agy-presentation", before ? "before" : "after");
const cwd = join(root, "workspace");
const home = join(root, "home");
const bin = join(root, "bin");
const profile = join(home, ".gemini", "antigravity-cli");
const nativeLog = join(root, "acp.ndjson");
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
  `#!/bin/sh\n${quote(agy)} "$@" --disable-telemetry | tee -a ${quote(nativeLog)}\n`,
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
  GEMINI_API_KEY: "isolated-agy-presentation",
});
delete process.env.DBUS_SESSION_BUS_ADDRESS;

const marker = "AGY_PRESENTATION_FILE_386";
const markerPath = join(cwd, "presentation-marker.txt");
await writeFile(markerPath, marker);
const first = "**检查输入**\n\n确认隔离项目路径。";
const adjacent = "\n\n**准备读取**\n\n核对文件名称。";
const long = "核对结果并生成图表。".repeat(26) + " 已准备完整输出。";
const diagram = "flowchart LR\n  A[读取标记] --> B[绘制结果]";
const answer = [
  "隔离演示结果",
  "\u0060\u0060\u0060mermaid\n" + diagram + "\n\u0060\u0060\u0060",
  "\u0060\u0060\u0060mermaid\ninvalid fixture diagram\n\u0060\u0060\u0060",
].join("\n\n");
const evidence = {
  version,
  requests: [],
  native: [],
  live: [],
  views: [],
  layout: [],
};
const releaseAnswer = Promise.withResolvers();
const releaseTurn = Promise.withResolvers();
const model = createServer(async (req, res) => {
  if (req.method === "GET") return res.end('{"models":[]}');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const { contents, systemInstruction } = JSON.parse(Buffer.concat(chunks));
  const title = JSON.stringify(systemInstruction).includes(
    "conversation title generator",
  );
  const hasToolResult = contents.some(({ parts }) =>
    parts.some(({ functionResponse }) =>
      JSON.stringify(functionResponse || {}).includes(marker),
    ),
  );
  const streaming = req.url.includes("streamGenerateContent");
  evidence.requests.push({ title, hasToolResult, streaming });
  const payload = (parts, finishReason) =>
    JSON.stringify({
      candidates: [{ content: { role: "model", parts }, finishReason }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
    });
  const packet = (parts, finishReason) =>
    "data: " + payload(parts, finishReason) + "\n\n";
  if (!streaming)
    return res
      .writeHead(200, { "content-type": "application/json" })
      .end(payload([{ text: "绘图演示" }], "STOP"));
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (title) return res.end(packet([{ text: "绘图演示" }], "STOP"));
  if (!hasToolResult) {
    res.write(packet([{ text: first, thought: true }]));
    res.write(packet([{ text: adjacent, thought: true }]));
    return res.end(
      packet(
        [{ functionCall: { name: "read_file", args: { Path: markerPath } } }],
        "STOP",
      ),
    );
  }
  res.write(packet([{ text: long, thought: true }]));
  await releaseAnswer.promise;
  const breakAt = answer.indexOf("mermaid") + 3;
  res.write(packet([{ text: answer.slice(0, breakAt) }]));
  res.write(packet([{ text: answer.slice(breakAt) }]));
  await releaseTurn.promise;
  res.end(packet([], "STOP"));
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
let page;
const selector = ".process-history .reasoning-summary";
const rendered = ".assistant-message .mermaid-diagram > svg";
const screenshot = (name) =>
  page.screenshot({
    path: join(output, name + ".png"),
    animations: "disabled",
  });

async function inspect(label) {
  const rows = await page
    .locator(".process-history .process-content > .activity")
    .evaluateAll((elements) =>
      elements.map((row) => ({
        reasoning: row.classList.contains("reasoning-summary"),
        expandable: row.tagName === "DETAILS",
        open: row.open ?? false,
        label: row.querySelector(".activity-summary")?.innerText,
        body: row.querySelector(".activity-body")?.textContent,
      })),
    );
  evidence.views.push({
    label,
    rows,
    diagrams: await page.locator(rendered).count(),
  });
  return rows;
}

async function verifyGroups(label) {
  const thoughts = page.locator(selector);
  await thoughts.last().waitFor();
  const rows = await inspect(label);
  if (before) return;
  assert.deepEqual(
    rows.map(({ reasoning }) => reasoning),
    [true, false, true],
  );
  assert.equal(rows[0].open, label === "live");
  assert.equal(rows[2].open, false);
  assert.equal(rows[2].expandable, true);
  assert.deepEqual(rows[0].label, "检查输入");
  assert.equal(rows[2].label, long);
  if (label !== "live") await thoughts.first().locator("summary").click();
  assert.match(await thoughts.first().innerText(), /准备读取/);
  const heading = thoughts.last().locator("summary");
  await heading.focus();
  await page.keyboard.press("Enter");
  assert((await thoughts.last().innerText()).includes(long));
}

try {
  await app.start();
  const url = "https://127.0.0.1:" + app.server.address().port;
  context = await chromium.launchPersistentContext(join(root, "browser"), {
    executablePath: process.env.CHROME_PATH,
    args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
    ignoreHTTPSErrors: true,
    viewport: { width: 1320, height: 1020 },
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
  page.setDefaultTimeout(12000);
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const { method, params } = JSON.parse(payload);
      if (method?.startsWith("item/") || method === "turn/completed")
        evidence.live.push({ method, params });
    }),
  );
  await page.goto(url);
  await page.getByRole("heading", { name: /今天想完成什么/ }).waitFor();
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("绘图演示");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const processHeading = page.locator(".process-history > summary");
  await processHeading.click();
  const firstHeading = page
    .locator(selector)
    .first()
    .locator(".activity-summary");
  await firstHeading.waitFor();
  if (
    await firstHeading
      .locator("..")
      .evaluate((row) => row.tagName === "DETAILS")
  )
    await firstHeading.click();
  try {
    await page.waitForFunction(
      ({ selector, long }) =>
        [...document.querySelectorAll(selector)].some((row) =>
          row.textContent.includes(long),
        ),
      { selector, long },
    );
  } finally {
    releaseAnswer.resolve();
  }
  await page.getByText("隔离演示结果", { exact: true }).waitFor();
  const valid = page.locator(".assistant-message .mermaid-block").first();
  const invalid = page.locator(".assistant-message .mermaid-block").last();
  if (!before) {
    await page.locator(rendered).waitFor();
    await invalid.getByText(/语法错误/).waitFor();
    assert.equal(
      (await invalid.locator("pre").innerText()).trim(),
      "invalid fixture diagram",
    );
  } else {
    await page
      .locator(rendered)
      .waitFor({ timeout: 3000 })
      .catch(() => {});
  }
  await verifyGroups("live");
  await screenshot("live-light");
  releaseTurn.resolve();
  await page
    .getByRole("button", { name: "停止任务", exact: true })
    .waitFor({ state: "hidden" });
  await page.reload();
  await page.getByText("隔离演示结果", { exact: true }).waitFor();
  await processHeading.click();
  await page.locator(rendered).waitFor();
  await verifyGroups("history");
  await screenshot("history-light");
  if (!before) {
    await valid.getByRole("button", { name: "放大图表" }).click();
    assert.equal(
      await valid.getByRole("button", { name: "重置图表缩放" }).innerText(),
      "125%",
    );
    await valid.getByRole("button", { name: "展开图表" }).click();
    assert.equal(
      await valid
        .getByRole("button", { name: "收起图表" })
        .getAttribute("aria-expanded"),
      "true",
    );
    await valid.getByRole("button", { name: "收起图表" }).click();
    await valid.getByRole("button", { name: "重置图表缩放" }).click();
    const browserSettings = await context.newPage();
    await browserSettings.goto("chrome://settings/appearance");
    const zoom = browserSettings.locator("#zoomLevel");
    for (const width of [1320, 390]) {
      await page.setViewportSize({ width, height: 1020 });
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: theme });
        for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
          await zoom.selectOption(String(scale));
          await page.waitForFunction(
            (scale) => Math.abs(devicePixelRatio - scale) < 0.02,
            scale,
          );
          await page.locator(rendered).waitFor();
          const geometry = await page
            .locator(selector)
            .last()
            .evaluate((row) => {
              const title = row.querySelector("summary > span");
              return {
                viewport: innerWidth,
                scroll: document.documentElement.scrollWidth,
                titleWidth: title.clientWidth,
                titleScroll: title.scrollWidth,
                ellipsis: getComputedStyle(title).textOverflow,
                bodyVisible:
                  row.querySelector(".activity-body").getBoundingClientRect()
                    .height > 0,
                dpr: devicePixelRatio,
              };
            });
          assert(Math.abs(geometry.viewport - width / scale) <= 1);
          assert(geometry.scroll <= geometry.viewport + 1);
          assert(geometry.titleWidth < geometry.titleScroll);
          assert.equal(geometry.ellipsis, "ellipsis");
          assert(geometry.bodyVisible);
          evidence.layout.push({ width, theme, scale, ...geometry });
          if (scale === 1 || (width === 390 && scale === 2)) {
            await page.locator(selector).last().scrollIntoViewIfNeeded();
            await screenshot(`history-${width}-${theme}-${scale}`);
          }
        }
      }
    }
    await zoom.selectOption("1");
    await browserSettings.close();
    await page.getByRole("button", { name: "显示侧栏" }).click();
    await page.getByRole("button", { name: "收起侧栏" }).click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector("#project-sidebar")
          .contains(document.activeElement),
    );
  }
  console.log(
    JSON.stringify({
      version,
      before,
      views: evidence.views.map(({ label, rows, diagrams }) => ({
        label,
        rows: rows.length,
        diagrams,
      })),
      layoutChecks: evidence.layout.length,
      output,
    }),
  );
} catch (error) {
  if (page) await screenshot("failure").catch(() => {});
  throw error;
} finally {
  releaseAnswer.resolve();
  releaseTurn.resolve();
  evidence.native = (await readFile(nativeLog, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line).params?.update)
    .filter((update) =>
      [
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
        "agent_message_chunk",
      ].includes(update?.sessionUpdate),
    );
  await writeFile(
    join(output, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  await context?.close();
  const worker = await connectIpc(
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

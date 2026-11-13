import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const before = process.env.BROWSER_BEFORE === "1";
const output = join(
  root,
  ".cache/status-rendering",
  before ? "before" : "after",
);
const build = before ? join(output, "dist") : join(root, "client/dist");
await mkdir(output, { recursive: true });
const startedAt = Date.now() / 1000;
const data = {
  activeTurns: {
    legacy: "legacy-turn",
    "backend:claude:fixture": "claude-turn",
  },
  turnStartedAt: startedAt,
  codexItems: [
    {
      id: "render-user",
      type: "userMessage",
      turnId: "legacy-turn",
      content: [{ type: "text", text: "检查运行状态与渲染开销" }],
    },
    {
      id: "render-command",
      type: "commandExecution",
      turnId: "legacy-turn",
      command: "npm test",
      cwd: "/demo/project",
      status: "inProgress",
      aggregatedOutput: "正在运行测试…",
    },
  ],
  claudeItems: [],
};
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
  args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
});
const evidence = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "no-preference",
  });
  await page.addInitScript(backendFixture, data);
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const request = { url: path };
    const response = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
        return this;
      },
      end(body) {
        this.body = body;
      },
    };
    if (serveDemoSession(request, response)) {
      await route.fulfill({
        status: response.status,
        headers: response.headers,
        body: response.body,
      });
      return;
    }
    try {
      await route.fulfill({
        body: await readFile(join(build, path === "/" ? "index.html" : path)),
        contentType:
          {
            ".js": "text/javascript",
            ".css": "text/css",
            ".woff2": "font/woff2",
          }[extname(path)] || "text/html",
      });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("https://fixture.invalid/");
  await page.locator(".process-duration").waitFor();
  await page.locator(".working-status").waitFor();
  await page.locator(".user-bubble").click();
  const draft = page.locator(".composer .ProseMirror");
  await draft.fill("检查之后保留的草稿");
  await page.locator(".user-bubble").click();
  await page.waitForTimeout(4500);
  const device = await page.context().newCDPSession(page);
  const events = [];
  device.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  await device.send("Tracing.start", {
    categories:
      "devtools.timeline,disabled-by-default-devtools.timeline.frame,cc",
  });
  const timerBefore = await page
    .locator(".process-duration")
    .getAttribute("datetime");
  await page.waitForTimeout(3100);
  const complete = new Promise((resolve) =>
    device.once("Tracing.tracingComplete", resolve),
  );
  await device.send("Tracing.end");
  await complete;
  const animations = await page.evaluate(() =>
    document.getAnimations().map((animation) => ({
      name: animation.animationName,
      state: animation.playState,
      iterations: animation.effect.getTiming().iterations,
      target: animation.effect.target.getAttribute("class"),
    })),
  );
  const frames = events.filter((event) => event.name === "DrawFrame").length;
  const counts = Object.fromEntries(
    [...new Set(events.map((event) => event.name))]
      .filter((name) => /Draw|Frame|Animation/i.test(name))
      .map((name) => [
        name,
        events.filter((event) => event.name === name).length,
      ]),
  );
  evidence.push({ scenario: "running", frames, animations, counts });
  if (before) {
    assert(animations.some((animation) => animation.state === "running"));
    assert(frames > 80, `持续动画触发高频渲染，实际 ${frames} 帧`);
  } else {
    assert.equal(
      animations.filter((animation) => animation.state === "running").length,
      0,
    );
    assert(frames < 20, `稳定运行期间按内容更新，实际 ${frames} 帧`);
  }
  assert.notEqual(
    await page.locator(".process-duration").getAttribute("datetime"),
    timerBefore,
  );
  assert.equal(await draft.innerText(), "检查之后保留的草稿");
  await page.screenshot({ path: join(output, "running-light.png") });
  await page.locator(".process-history > summary").click();
  await page.locator(".activity").waitFor();
  await page.screenshot({ path: join(output, "running-expanded.png") });
  await page.locator(".process-history > summary").click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(output, "running-dark.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, "running-mobile.png") });
  await page.evaluate(() => {
    window.backendSocket.emit("item/completed", {
      threadId: "legacy",
      turnId: "legacy-turn",
      item: {
        id: "render-command",
        type: "commandExecution",
        command: "npm test",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "测试已完成",
      },
    });
    window.backendSocket.emit("turn/completed", {
      threadId: "legacy",
      turn: {
        id: "legacy-turn",
        status: "completed",
        completedAt: Date.now() / 1000,
      },
    });
  });
  await page.locator(".working-status").waitFor({ state: "hidden" });
  const finished = await page
    .locator(".process-duration")
    .getAttribute("datetime");
  await page.waitForTimeout(1100);
  assert.equal(
    await page.locator(".process-duration").getAttribute("datetime"),
    finished,
  );
  assert.equal(await draft.innerText(), "检查之后保留的草稿");
  await page.screenshot({ path: join(output, "completed-mobile.png") });
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  await browser.close();
}

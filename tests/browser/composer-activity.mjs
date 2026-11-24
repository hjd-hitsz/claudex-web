import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createStaticHandler } from "../../server/src/http/static.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";

const codexTurn = "legacy-turn";
const claudeThread = "backend:claude:fixture";
const codexAgent = {
  id: "spawn-review",
  turnId: codexTurn,
  type: "collabAgentToolCall",
  tool: "spawnAgent",
  status: "completed",
  receiverThreadIds: ["review-agent"],
  agentsStates: { "review-agent": { status: "pendingInit", message: null } },
};
const nativeActivity = {
  id: "new-agent-start",
  turnId: codexTurn,
  type: "subAgentActivity",
  kind: "started",
  agentThreadId: "test-agent",
  agentPath: "/root/test-runner",
};
const claudeAgent = {
  id: "agent-fixture-child",
  turnId: "human",
  type: "subAgentActivity",
  kind: "started",
  agentThreadId: "backend:claude:agent/fixture/child",
  agentPath: "接口审阅",
};
const fixture = {
  backendSettings: { codex: { backgroundTerminalAvailable: true } },
  backgroundTasks: {
    legacy: [
      {
        id: "task",
        title: "运行验证脚本",
        status: "running",
        startedAt: Date.now(),
      },
    ],
  },
  codexItems: [
    {
      id: "fixture-request",
      turnId: codexTurn,
      type: "userMessage",
      content: [{ type: "text", text: "请并行检查项目接口并运行验证脚本。" }],
    },
    {
      ...nativeActivity,
      id: "past-agent",
      kind: "completed",
      agentThreadId: "previous-agent",
      agentPath: "/root/previous-review",
    },
    codexAgent,
    nativeActivity,
  ],
  claudeItems: [claudeAgent],
};
const output = resolve(".cache/composer-activity");
await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "claudex-composer-activity-"));
const serveStatic = createStaticHandler(resolve("client/dist"));
const server = http.createServer((req, res) => {
  if (serveDemoSession(req, res)) return;
  return serveStatic(req, res, new URL(req.url, "http://fixture").pathname);
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH,
    args: ["--disable-gpu", "--no-proxy-server"],
  });
  const page = context.pages()[0];
  page.setDefaultTimeout(6000);
  await page.addInitScript({
    content: `(${backendFixture})(${JSON.stringify(fixture)});
      localStorage.setItem("cx-theme", JSON.stringify("system"));`,
  });
  const settings = await context.newPage();
  await settings.goto("chrome://settings/appearance");
  const zoom = settings.locator("#zoomLevel");
  await page.bringToFront();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const composer = page.locator(".composer");
  const agent = composer.getByRole("button", { name: /^活跃子代理/ });
  const terminal = composer.getByRole("button", { name: /^后台终端/ });
  const overview = page.getByRole("region", { name: "对话功能" });
  const results = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
        await zoom.selectOption(String(scale));
        await page.goto(origin);
        await agent.waitFor();
        await terminal.waitFor();
        assert.equal(await agent.innerText(), "2");
        assert.equal(await terminal.innerText(), "1");
        const metrics = await agent.evaluate((button) => {
          const { left, right, top, bottom, width, height } =
            button.getBoundingClientRect();
          const label = button.querySelector("span").getBoundingClientRect();
          return {
            colorScheme: getComputedStyle(document.documentElement).colorScheme,
            dpr: devicePixelRatio,
            innerWidth,
            innerHeight,
            left,
            right,
            top,
            bottom,
            width,
            height,
            labelRight: label.right,
          };
        });
        assert.equal(metrics.colorScheme, theme);
        assert.ok(Math.abs(metrics.dpr - scale) < 0.02);
        assert.ok(
          metrics.left >= 0 &&
            metrics.right <= metrics.innerWidth &&
            metrics.top >= 0 &&
            metrics.bottom <= metrics.innerHeight,
        );
        assert.ok(
          metrics.width >= 26 &&
            metrics.height >= 26 &&
            metrics.labelRight <= metrics.right,
        );
        results.push({ width, theme, scale, ...metrics });
        if (scale === 1)
          await composer.screenshot({
            path: join(output, `${width}-${theme}-composer.png`),
          });
        await agent.focus();
        await page.keyboard.press("Enter");
        await overview.waitFor();
        assert.equal(await agent.getAttribute("aria-expanded"), "true");
        assert.match(
          await overview
            .locator(".context-agent-list button")
            .first()
            .innerText(),
          /正在启动/,
        );
        await overview.getByText("运行验证脚本").waitFor();
        assert.ok(
          await overview.evaluate((card) => {
            const tools = document.querySelector(".context-tools");
            return (
              card.getBoundingClientRect().right <=
              tools.getBoundingClientRect().left
            );
          }),
        );
        if (scale === 1)
          await page.screenshot({
            path: join(output, `${width}-${theme}-overview.png`),
          });
        await page.keyboard.press("Enter");
        await overview.waitFor({ state: "hidden" });
      }
    }
  }
  await zoom.selectOption("1");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await page.getByRole("button", { name: "显示侧栏" }).click();
  const sidebarClose = page.getByRole("button", { name: "收起侧栏" });
  await sidebarClose.click();
  await page.getByRole("button", { name: "显示侧栏" }).waitFor();
  assert.ok(
    await page
      .getByRole("button", { name: "显示侧栏" })
      .evaluate((button) => button === document.activeElement),
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin);
  await agent.waitFor();
  await page.evaluate(
    ({ codexAgent, nativeActivity }) => {
      const emit = (item) =>
        window.backendSocket.emit("item/completed", {
          threadId: "legacy",
          turnId: item.turnId,
          item,
        });
      emit({
        ...nativeActivity,
        id: "new-agent-interrupted",
        kind: "interrupted",
      });
      emit({
        ...codexAgent,
        agentsStates: { "review-agent": { status: "running" } },
      });
    },
    { codexAgent, nativeActivity },
  );
  await composer.getByRole("button", { name: /活跃子代理，1 个/ }).waitFor();
  await page.evaluate(
    (item) =>
      window.backendSocket.emit("item/completed", {
        threadId: "legacy",
        turnId: item.turnId,
        item: {
          ...item,
          agentsStates: { "review-agent": { status: "errored" } },
        },
      }),
    codexAgent,
  );
  await agent.waitFor({ state: "hidden" });
  await terminal.waitFor();

  const project = page
    .locator(".project-heading button")
    .filter({ hasText: /^project$/ });
  if ((await project.getAttribute("aria-expanded")) !== "true")
    await project.click();
  await page.getByText("Claude 原生消息归属", { exact: true }).click();
  await composer.getByRole("button", { name: /活跃子代理，1 个/ }).waitFor();
  await terminal.waitFor({ state: "hidden" });
  await agent.click();
  await overview.getByText("接口审阅", { exact: true }).waitFor();
  await page.evaluate(
    ({ item, threadId }) =>
      window.backendSocket.emit("item/completed", {
        threadId,
        turnId: item.turnId,
        item: { ...item, kind: "completed" },
      }),
    { item: claudeAgent, threadId: claudeThread },
  );
  await agent.waitFor({ state: "hidden" });
  await overview.getByText("已完成", { exact: true }).waitFor();
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(`活跃子代理回归通过，覆盖 ${results.length} 组浏览器布局。`);
} finally {
  await context?.close();
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true });
}

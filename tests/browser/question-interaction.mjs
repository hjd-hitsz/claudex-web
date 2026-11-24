import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createStaticHandler } from "../../server/src/http/static.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";

const options = [
  { label: "保留现状", description: "沿用当前设置。" },
  { label: "采用新方案", description: "应用本次任务中的设置。" },
];
const questions = [
  {
    id: "install",
    question: "希望使用哪种部署方式？",
    options,
    isOther: false,
  },
  { id: "notify", question: "需要配置完成通知吗？", options, isOther: false },
  { id: "details", question: "对验证结果还有哪些要求？" },
];
const request = {
  id: "question-browser-fixture",
  method: "item/tool/requestUserInput",
  params: { threadId: "legacy", turnId: "legacy-turn", questions },
};
const output = resolve(".cache/question-interaction/browser");
const profile = await mkdtemp(join(tmpdir(), "claudex-question-browser-"));
await mkdir(output, { recursive: true });
const serveStatic = createStaticHandler(resolve("client/dist"));
const server = http.createServer((req, res) => {
  if (serveDemoSession(req, res)) return;
  return serveStatic(req, res, new URL(req.url, "http://fixture").pathname);
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
const results = [];
try {
  const { chromium } = await import(
    pathToFileURL(process.env.PLAYWRIGHT_MODULE)
  );
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH,
    args: ["--disable-gpu", "--no-proxy-server"],
  });
  const page = context.pages()[0];
  const settings = await context.newPage();
  await settings.goto("chrome://settings/appearance");
  const zoom = settings.locator("#zoomLevel");
  await zoom.waitFor();
  await page.bringToFront();
  const fixture = {
    activeTurns: { legacy: "legacy-turn" },
    turnStartedAt: Math.floor(Date.now() / 1000) - 12,
    codexItems: [
      {
        id: "fixture-user",
        turnId: "legacy-turn",
        type: "userMessage",
        content: [{ type: "text", text: "请根据我的偏好完成部署与验证。" }],
      },
      {
        id: "fixture-progress",
        turnId: "legacy-turn",
        type: "agentMessage",
        phase: "commentary",
        text: "已检查项目设置，部署前有几项需要确认。",
      },
    ],
  };
  await page.addInitScript({
    content: `(${backendFixture.toString()})(${JSON.stringify(fixture)})`,
  });
  const card = page.locator(".user-input-card");
  const next = card.getByRole("button", { name: "下一题" });
  const previous = card.getByRole("button", { name: "上一题" });
  const previousArrow = card.locator('button[aria-label="上一题"]');
  const submit = card.locator('button[type="submit"]');
  const replies = () =>
    page.evaluate(
      (id) => fixtureRequests.filter((message) => message.id === id),
      request.id,
    );
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
        await zoom.selectOption(String(scale));
        await page.goto(origin, { waitUntil: "domcontentloaded" });
        await page
          .getByText("请根据我的偏好完成部署与验证。", { exact: true })
          .waitFor();
        await page.evaluate(
          ({ request, theme }) => {
            document.documentElement.dataset.theme = theme;
            window.backendSocket.onmessage({ data: JSON.stringify(request) });
          },
          { request, theme },
        );
        await card.waitFor();
        assert.equal(await card.count(), 1);
        assert.equal(await card.locator("fieldset").count(), 1);
        assert.equal(await submit.count(), 1);
        assert.equal(await previousArrow.getAttribute("aria-disabled"), "true");
        assert.equal(await card.locator(":checked").count(), 0);
        assert.equal(await submit.isDisabled(), true);
        await card.getByRole("radio", { name: /保留现状/ }).check();
        await next.focus();
        await page.keyboard.press("Enter");
        await card.getByText(questions[1].question, { exact: true }).waitFor();
        assert.equal(
          await next.evaluate((button) => button === document.activeElement),
          true,
        );
        await card.getByRole("radio", { name: /保留现状/ }).check();
        await card.getByRole("button", { name: "拒答此题" }).click();
        await card
          .getByRole("status")
          .getByText("已拒答", { exact: true })
          .waitFor();
        assert.equal(
          await card.locator("fieldset").getAttribute("aria-label"),
          questions[1].question,
        );
        const stem = `${width}-${theme}-${scale}`;
        if (scale === 1)
          await page.screenshot({ path: join(output, `${stem}-declined.png`) });
        await next.click();
        await card.getByRole("textbox").fill("核对服务状态与验证结果");
        await previous.click();
        await card.getByRole("button", { name: "恢复作答" }).click();
        assert.equal(
          await card.getByRole("radio", { name: /保留现状/ }).isChecked(),
          true,
        );
        await card.getByRole("button", { name: "拒答此题" }).click();
        await previous.click();
        assert.equal(
          await card.getByRole("radio", { name: /保留现状/ }).isChecked(),
          true,
        );
        await card.getByRole("radio", { name: /采用新方案/ }).check();
        await next.click();
        await next.click();
        assert.equal(
          await card.getByRole("textbox").inputValue(),
          "核对服务状态与验证结果",
        );
        assert.equal(await submit.isEnabled(), true);
        assert.deepEqual(await replies(), []);
        if (width === 390) {
          await page.getByRole("button", { name: "显示侧栏" }).click();
          await page.getByRole("button", { name: "收起侧栏" }).click();
          assert.equal(
            await page
              .locator(".sidebar")
              .evaluate((sidebar) => sidebar.contains(document.activeElement)),
            false,
          );
        }
        const metrics = await card.evaluate((form) => ({
          dpr: devicePixelRatio,
          viewport: innerWidth,
          controls: [...form.querySelectorAll("button")].map((button) => {
            const { left, right, width, height } =
              button.getBoundingClientRect();
            return { left, right, width, height };
          }),
        }));
        assert.ok(Math.abs(metrics.dpr - scale) < 0.02);
        assert.ok(Math.abs(metrics.viewport - width / scale) <= 1);
        for (const { left, right, width, height } of metrics.controls)
          assert.ok(
            left >= 0 &&
              right <= metrics.viewport + 1 &&
              width >= 30 &&
              height >= 30,
            JSON.stringify(metrics),
          );
        if (scale === 1 || scale === 2)
          await page.screenshot({ path: join(output, `${stem}-ready.png`) });
        await submit.click();
        await card.waitFor({ state: "detached" });
        assert.deepEqual(await replies(), [
          {
            id: request.id,
            result: {
              answers: {
                install: { answers: ["采用新方案"] },
                notify: { answers: [] },
                details: { answers: ["核对服务状态与验证结果"] },
              },
            },
          },
        ]);
        if (scale === 1) {
          await page.locator(".process-history > summary").click();
          const history = page.locator(".historical-questions");
          await history.locator("summary").click();
          await history.getByText("已拒答", { exact: true }).waitFor();
          await page.screenshot({
            path: join(output, `${stem}-submitted.png`),
          });
        }
        results.push({ width, theme, scale, ...metrics });
      }
      console.log(`PASS ${width}px ${theme}，80% 至 200% 浏览器缩放`);
    }
  }
  await zoom.selectOption("1");
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(
      {
        build: JSON.parse(await readFile(resolve("build-info.json"), "utf8")),
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS ${results.length} 个生产页面场景，三题自由切换、逐题拒答、唯一提交按钮与结果回显`,
  );
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createStaticHandler } from "../../server/src/http/static.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";

const before = process.env.BROWSER_BEFORE === "1";
const output = resolve(
  ".cache/conversation-width",
  before ? "before" : "after",
);
const build = process.env.BROWSER_BUILD_DIR || resolve("client/dist");
await mkdir(output, { recursive: true });

const terms = Array.from({ length: 28 }, (_, index) => "x_{" + index + "}");
const text = [
  "手机阅读时，消息应从左侧完整显示。",
  "$$\n" + terms.join(" + ") + "\n$$",
  "行内公式 $" + "\\left[" + terms.join(",") + "\\right]" + "$ 之后继续阅读。",
  "普通公式 $x_{\\mathrm{new}}$、$x_{\\mathrm{nearest}}$、$\\gamma_{\\mathrm{RRT}^{*}}$ 和 $D^2$ 保持在这一行。",
  "```text\n" + "path/to/example/".repeat(30) + "\n```",
  "| " +
    terms.join(" | ") +
    " |\n| " +
    terms.map(() => "---").join(" | ") +
    " |\n| " +
    terms.map(() => "数据内容").join(" | ") +
    " |",
  "正文末尾可以继续纵向滚动。",
  "[预览笔记](./notes.md)",
  "阅读记录\n\n" + "这段正文用于核对手势后仍可上下阅读。\n\n".repeat(18),
].join("\n\n");
const data = {
  codexItems: [
    {
      id: "user",
      turnId: "legacy-turn",
      type: "userMessage",
      content: [{ type: "text", text: "检查公式、代码与数据表。" }],
    },
    {
      id: "answer",
      turnId: "legacy-turn",
      type: "agentMessage",
      phase: "final_answer",
      text,
    },
  ],
  claudeItems: [],
};
const serveStatic = createStaticHandler(build);
const server = http.createServer((request, response) => {
  if (serveDemoSession(request, response)) return;
  return serveStatic(
    request,
    response,
    new URL(request.url, "http://fixture").pathname,
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "claudex-conversation-width-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  headless: true,
  viewport: { width: 390, height: 844 },
  args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
});
const page = await context.newPage();
page.setDefaultTimeout(10_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const origin = "http://127.0.0.1:" + server.address().port;
const conversation = page.locator(".conversation");
const answer = conversation.locator(".assistant-message .markdown");
const formula = answer.locator(".katex-display");
const inline = answer.locator("p > .katex").first();
const prose = answer.getByText("手机阅读时，消息应从左侧完整显示。");
const code = answer.locator(".code-block pre");
const table = answer.locator("table");
const preview = page.locator(".file-markdown-preview");
const results = [];

async function inspect() {
  await formula.waitFor();
  await page.evaluate(() => document.fonts.ready);
  return conversation.evaluate((element) => {
    const column = element
      .querySelector(".message-column")
      .getBoundingClientRect();
    const display = element.querySelector(".katex-display");
    const inline = element.querySelector("p > .katex");
    const short = Array.from(element.querySelectorAll("p > .katex")).slice(1);
    return {
      viewport: innerWidth,
      dpr: devicePixelRatio,
      pageWidth: document.documentElement.scrollWidth,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
      messageLeft: column.left,
      messageRight: column.right,
      displayFormula: {
        width: display.clientWidth,
        scrollWidth: display.scrollWidth,
      },
      inlineFormula: {
        width: inline.clientWidth,
        scrollWidth: inline.scrollWidth,
      },
      shortFormulas: short.map((formula) => ({
        overflowX: getComputedStyle(formula).overflowX,
        overflowY: getComputedStyle(formula).overflowY,
      })),
    };
  });
}

function assertConversationFits(metrics) {
  assert(metrics.pageWidth <= metrics.viewport, JSON.stringify(metrics));
  assert.equal(
    metrics.scrollWidth,
    metrics.clientWidth,
    JSON.stringify(metrics),
  );
  assert.equal(metrics.scrollLeft, 0, JSON.stringify(metrics));
  assert(
    metrics.messageLeft >= 0 && metrics.messageRight <= metrics.viewport,
    JSON.stringify(metrics),
  );
  assert.deepEqual(
    metrics.shortFormulas,
    Array.from({ length: 4 }, () => ({
      overflowX: "visible",
      overflowY: "visible",
    })),
  );
}

async function localScrolling(locator) {
  await locator.scrollIntoViewIfNeeded();
  const max = await locator.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  assert(max > 0, `${locator} 保留内容宽度`);
  await swipe(locator, -135);
  assert(
    await locator.evaluate((element) => element.scrollLeft > 0),
    `${locator} 可触屏横向滚动`,
  );
  const end = await locator.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return element.scrollLeft;
  });
  assert.equal(end, max);
  assertConversationFits(await inspect());
  await locator.evaluate((element) => {
    element.scrollLeft = 0;
  });
}

async function swipe(locator, deltaX, deltaY = 0) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert(box);
  const x = Math.round(box.x + Math.min(box.width - 8, 240));
  const y = Math.round(box.y + Math.min(box.height / 2, 40));
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  for (let step = 1; step <= 8; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + (deltaX * step) / 8, y: y + (deltaY * step) / 8 }],
    });
  }
  // End with a stationary touch so the next assertion measures the drag.
  await page.waitForTimeout(120);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
}

async function sidebar() {
  await page.getByRole("button", { name: "显示侧栏", exact: true }).click();
  const close = page.getByRole("button", { name: "收起侧栏", exact: true });
  await close.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".sidebar.mobile-open")?.getBoundingClientRect()
        .left >= -1,
  );
  const box = await close.boundingBox();
  assert(box && box.x >= 0 && box.x + box.width <= (await inspect()).viewport);
  await close.click();
  await page.locator(".sidebar").waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(
      () => document.activeElement.closest(".sidebar") !== null,
    ),
    false,
  );
}

const cdp = await context.newCDPSession(page);
try {
  await context.addInitScript(backendFixture, data);
  await context.addInitScript((markdown) => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (raw) {
      const { id, method } = JSON.parse(raw);
      if (method !== "fs/readFile") return send.call(this, raw);
      const dataBase64 = btoa(
        String.fromCharCode(...new TextEncoder().encode(markdown)),
      );
      setTimeout(
        () =>
          this.onmessage({
            data: JSON.stringify({ id, result: { dataBase64 } }),
          }),
        0,
      );
    };
  }, text);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await page.goto(origin);
  await formula.scrollIntoViewIfNeeded();
  await conversation.evaluate((element) => {
    element.scrollTop = 0;
  });
  const original = await inspect();
  await swipe(formula, -165);
  const dragged = await inspect();
  await page.screenshot({ path: join(output, "mobile-light-drag.png") });
  results.push({ original, dragged });
  if (before) {
    assert(
      original.scrollWidth > original.clientWidth,
      JSON.stringify(original),
    );
    assert(
      dragged.scrollLeft > 0 && dragged.messageLeft < original.messageLeft,
      JSON.stringify(dragged),
    );
  } else {
    assertConversationFits(original);
    assertConversationFits(dragged);
    assert.equal(dragged.messageLeft, original.messageLeft);
    await formula.evaluate((element) => {
      element.scrollLeft = 0;
    });
    for (const content of [formula, inline, code, table])
      await localScrolling(content);
    await swipe(prose, -145);
    const beforeVertical = await inspect();
    assertConversationFits(beforeVertical);
    await swipe(prose, 0, -130);
    await page.waitForFunction(
      (top) => document.querySelector(".conversation").scrollTop > top,
      beforeVertical.scrollTop,
    );
    await conversation.evaluate((element) => {
      element.scrollTop = 0;
    });
    await sidebar();
    await conversation.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await page.screenshot({ path: join(output, "mobile-dark.png") });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp.send("Emulation.clearDeviceMetricsOverride");

    const settings = await context.newPage();
    await settings.goto("chrome://settings/appearance");
    const zoom = settings.locator("#zoomLevel");
    await zoom.waitFor();
    try {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of ["light", "dark"]) {
          for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
            await zoom.selectOption(String(scale));
            await page.bringToFront();
            await page.waitForFunction(
              (scale) => Math.abs(devicePixelRatio - scale) < 0.02,
              scale,
            );
            await page.evaluate((theme) => {
              document.documentElement.dataset.theme = theme;
            }, theme);
            await conversation.evaluate((element) => {
              element.scrollTop = 0;
            });
            const metrics = await inspect();
            assert(
              Math.abs(metrics.viewport - width / scale) <= 1,
              JSON.stringify(metrics),
            );
            assertConversationFits(metrics);
            if (scale === 1 || scale === 2)
              await page.screenshot({
                path: join(output, `${width}-${theme}-${scale}.png`),
              });
            results.push({ width, theme, scale, ...metrics });
            await settings.bringToFront();
          }
        }
      }
    } finally {
      await zoom.selectOption("1");
      await settings.close();
    }
    await page.getByRole("link", { name: "预览笔记" }).click();
    await preview.locator("table").waitFor();
    const file = await preview.evaluate((element) => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      tableOverflow:
        element.querySelector("table").scrollWidth >
        element.querySelector("table").clientWidth,
    }));
    assert.equal(file.scrollWidth, file.width, JSON.stringify(file));
    assert(file.tableOverflow, JSON.stringify(file));
    assert(await preview.getByText("正文末尾可以继续纵向滚动。").isVisible());
    assert(
      (await preview.locator(".katex").count()) >= 4,
      "文件富文本预览仍渲染行内和块公式",
    );
    await page.screenshot({ path: join(output, "mobile-file-preview.png") });
    results.push({ file });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(JSON.stringify({ output, cases: results.length }));
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
}
